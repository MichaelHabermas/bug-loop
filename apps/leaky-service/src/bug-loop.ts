import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  definePipelineConfig,
  readNewEvents,
  reproCheckPasses,
  type CheckResult,
  type Incident,
  type LogEvent,
  type PipelineConfig,
  type ReproPlan,
  type ReproResult,
  type ReproStrategy,
  type ReproStrategyInput,
  type VerifyReproInput,
} from "@bug-loop/core";

export interface LeakyServiceConfigInput {
  cursorPath: string;
  baseUrl: string;
  fixer: PipelineConfig["fixer"];
  logPath?: string;
}

export function createLeakyServicePipelineConfig(
  input: LeakyServiceConfigInput,
): PipelineConfig {
  return definePipelineConfig({
    repo: "MichaelHabermas/bug-loop",
    labels: {
      pipeline: "bug-loop",
      mechanical: "auto-fix-candidate",
      needsHuman: "needs-human",
    },
    logPath: input.logPath ?? join(import.meta.dir, "../../../logs/leaky-service.jsonl"),
    baseUrl: input.baseUrl,
    cursorPath: input.cursorPath,
    fixScope: ["apps/leaky-service/src"],
    worktreeRoot: ".worktrees",
    maxFixAttempts: 2,
    fixer: input.fixer,
    invariantWarnPrefixes: ["order total negative"],
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function curlPost(url: string, body?: string): string {
  const data = body === undefined
    ? ""
    : ` -H 'content-type: application/json' --data ${shellQuote(body)}`;
  return `curl -sS -X POST${data} ${shellQuote(url)}`;
}

function shipBody(): string {
  return JSON.stringify({
    customer: { id: "bug-loop-repro", name: "Bug Loop" },
    items: [{ sku: "REPRO-SHIP", qty: 1, priceCents: 100 }],
  });
}

function discountBody(): string {
  return JSON.stringify({
    customer: { id: "bug-loop-repro", name: "Bug Loop" },
    items: [{ sku: "REPRO-DISCOUNT", qty: 1, priceCents: 1000 }],
    discountPercent: 150,
  });
}

function missingCustomerBody(): string {
  return JSON.stringify({
    items: [{ sku: "REPRO-CUSTOMER", qty: 1, priceCents: 100 }],
  });
}

function buildCommand(baseUrl: string, incident: Incident, sample: LogEvent): string | null {
  if (incident.fingerprint.route === "POST /orders/:id/ship") {
    const createCommand = curlPost(`${baseUrl}/orders`, shipBody());
    const shipUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/ship");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST ${shipUrl}`;
  }
  if (incident.fingerprint.route === "GET /orders") {
    return `curl -sS ${shellQuote(`${baseUrl}/orders?since=last-week`)}`;
  }
  if (incident.fingerprint.route === "POST /orders") {
    return curlPost(
      `${baseUrl}/orders`,
      sample.level === "warn" ? discountBody() : missingCustomerBody(),
    );
  }
  return null;
}

async function responseEvidence(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 500);
  return `HTTP ${response.status}${body ? `\n${body}` : ""}`;
}

async function reproduceShip(input: ReproStrategyInput): Promise<Omit<ReproResult, "command">> {
  const before = { offset: Bun.file(input.logPath).size };
  const createResponse = await fetch(`${input.baseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: shipBody(),
  });
  const created: unknown = await createResponse.json();
  if (typeof created !== "object" || created === null) {
    return { reproduced: false, evidence: "Create response did not contain an order." };
  }
  const id = (created as Record<string, unknown>)["id"];
  if (typeof id !== "string") {
    return { reproduced: false, evidence: "Create response did not contain an order id." };
  }
  const shipResponse = await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/ship`, {
    method: "POST",
  });
  await Bun.sleep(120);
  const newLogs = await readNewEvents(input.logPath, before);
  const timeout = newLogs.events.find(
    (event) =>
      event.msg === "unhandledRejection" &&
      event.err?.message.includes(`shipping provider timeout for ${id}`),
  );
  return {
    reproduced: timeout !== undefined,
    evidence: timeout
      ? `HTTP ${shipResponse.status}\n${JSON.stringify(timeout)}`
      : `HTTP ${shipResponse.status}\nNo matching timeout log appeared.`,
  };
}

async function reproduce(input: ReproStrategyInput): Promise<Omit<ReproResult, "command">> {
  if (input.incident.fingerprint.route === "POST /orders/:id/ship") {
    return reproduceShip(input);
  }
  if (input.sample.level === "warn") {
    const response = await fetch(`${input.baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: discountBody(),
    });
    return {
      reproduced: false,
      evidence:
        `Invariant request completed but remains a product-policy question.\n${await responseEvidence(response)}`,
    };
  }
  if (input.incident.fingerprint.route === "GET /orders") {
    const response = await fetch(`${input.baseUrl}/orders?since=last-week`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  const response = await fetch(`${input.baseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: missingCustomerBody(),
  });
  return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
}

async function selectFreePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate a verification port");
  return port;
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The service may still be starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`service did not become healthy at ${baseUrl}`);
}

interface IncidentRequestResult {
  completed: boolean;
  evidence: string;
}

async function runIncidentRequest(
  baseUrl: string,
  incident: Incident,
): Promise<IncidentRequestResult> {
  const route = incident.fingerprint.route;
  if (route === "GET /orders") {
    const response = await fetch(`${baseUrl}/orders?since=last-week`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders") {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: missingCustomerBody(),
    });
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/:id/ship") {
    const create = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: shipBody(),
    });
    const value: unknown = await create.json();
    if (typeof value !== "object" || value === null) {
      return { completed: false, evidence: "create response did not contain an object" };
    }
    const id = (value as Record<string, unknown>)["id"];
    if (typeof id !== "string") {
      return { completed: false, evidence: "create response did not contain an order id" };
    }
    const ship = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    await Bun.sleep(150);
    return {
      completed: true,
      evidence: `create HTTP ${create.status}; ship HTTP ${ship.status}\n${(await ship.text()).slice(0, 500)}`,
    };
  }
  return { completed: false, evidence: `no verifier reproduction for ${route}` };
}

function failureSignaturePresent(incident: Incident, events: LogEvent[]): boolean {
  if (incident.fingerprint.route === "POST /orders/:id/ship") {
    return events.some((event) => event.msg === "unhandledRejection");
  }
  return events.some(
    (event) =>
      event.err?.name === incident.fingerprint.errName &&
      event.route === incident.fingerprint.route,
  );
}

async function verify(input: VerifyReproInput): Promise<CheckResult> {
  const fingerprint8 = input.incident.fingerprint.hash.slice(0, 8);
  const logPath = join(input.worktreeDir, "logs", `verify-${fingerprint8}.jsonl`);
  await rm(logPath, { force: true });
  const port = await selectFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = Bun.spawn(["bun", "run", "apps/leaky-service/src/server.ts"], {
    cwd: input.worktreeDir,
    env: { ...Bun.env, PORT: String(port), LOG_PATH: logPath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForHealth(baseUrl);
    const request = await runIncidentRequest(baseUrl, input.incident);
    const logs = await readNewEvents(logPath);
    const signaturePresent = failureSignaturePresent(input.incident, logs.events);
    return {
      passes: reproCheckPasses(request.completed, signaturePresent),
      detail: [
        request.evidence,
        !request.completed
          ? "The incident reproduction request did not complete."
          : signaturePresent
            ? `${input.incident.fingerprint.errName} failure signature still present in fresh worktree log.`
            : `${input.incident.fingerprint.errName} failure signature absent from fresh worktree log.`,
      ].join("\n"),
    };
  } finally {
    if (service.exitCode === null) service.kill("SIGTERM");
    const stopped = await Promise.race([
      service.exited.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!stopped) {
      if (service.exitCode === null) service.kill("SIGKILL");
      await service.exited;
    }
  }
}

export class LeakyServiceReproStrategy implements ReproStrategy {
  normalizeEvent(event: LogEvent): LogEvent {
    if (
      event.route === undefined &&
      event.msg === "unhandledRejection" &&
      event.err?.message.startsWith("shipping provider timeout")
    ) {
      return { ...event, route: "POST /orders/:id/ship" };
    }
    return event;
  }

  derive(input: ReproStrategyInput): ReproPlan | null {
    const command = buildCommand(input.baseUrl.replace(/\/$/, ""), input.incident, input.sample);
    if (command === null) return null;
    return {
      command,
      reproduce: () => reproduce({ ...input, baseUrl: input.baseUrl.replace(/\/$/, "") }),
      verify,
    };
  }
}

export const leakyServiceReproStrategy = new LeakyServiceReproStrategy();

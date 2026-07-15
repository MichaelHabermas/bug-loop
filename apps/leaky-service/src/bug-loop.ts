import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  type RegressionFixturePlan,
  type RegressionTestStrategy,
  type RoutingPolicy,
  type RoutingPolicyDecision,
  type VerifyReproInput,
} from "@bug-loop/core";

export interface LeakyServiceConfigInput {
  cursorPath: string;
  baseUrl: string;
  fixer: PipelineConfig["fixer"];
  logPath?: string;
  incidentConcurrency?: number;
}

export const LEAKY_SERVICE_CONTRACTS = [
  {
    id: "leaky-service.valid-create.status-201",
    statement: "A valid create-order request returns HTTP 201.",
  },
  {
    id: "leaky-service.valid-list.status-200",
    statement: "A valid list-orders request returns HTTP 200.",
  },
  {
    id: "leaky-service.valid-ship.status-200",
    statement: "A valid ship-order request returns HTTP 200.",
  },
] as const;

export const LEAKY_SERVICE_INCIDENT_CLASSES = {
  missingCustomer: "leaky-service.missing-customer",
  invalidSince: "leaky-service.invalid-since",
  shippingTimeout: "leaky-service.shipping-timeout",
} as const;

type LeakyServiceIncidentClass = typeof LEAKY_SERVICE_INCIDENT_CLASSES[keyof typeof LEAKY_SERVICE_INCIDENT_CLASSES];

const AUTHORIZED_CLASSES: readonly LeakyServiceIncidentClass[] = [
  LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
  LEAKY_SERVICE_INCIDENT_CLASSES.invalidSince,
  LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout,
];

function classifyIncident(incident: Incident): RoutingPolicyDecision {
  const sample = incident.sampleEvents[0];
  if (sample?.level === "warn") {
    return {
      kind: "deny",
      reason: "Warning-level invariants require product-policy review, not a mechanical fix.",
    };
  }
  const fingerprint = incident.fingerprint;
  if (
    fingerprint.route === "POST /orders" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleCreate")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
      reason: "The missing-customer crash matches the application-owned create-order contract.",
    };
  }
  if (
    fingerprint.route === "GET /orders" && fingerprint.errName === "RangeError" &&
    fingerprint.topFrame.includes("handleList")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.invalidSince,
      reason: "The invalid-since crash matches the application-owned list-orders contract.",
    };
  }
  if (
    fingerprint.route === "POST /orders/:id/ship" && fingerprint.errName === "Error" &&
    (fingerprint.topFrame.includes("callShippingProvider") ||
      sample?.err?.message.startsWith("shipping provider timeout") === true)
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout,
      reason: "The provider-timeout crash matches the application-owned ship-order contract.",
    };
  }
  return { kind: "unknown", reason: "The incident does not match a known crash contract." };
}

export const leakyServiceRoutingPolicy: RoutingPolicy = {
  authorizedClasses: AUTHORIZED_CLASSES,
  evaluate: ({ incident }) => classifyIncident(incident),
};

interface FixtureManifestEntry {
  fixtureId: string;
  contractSource: string;
  matches(incident: Incident): boolean;
  source(incident: Incident, reproCommand: string): string;
}

function fixtureHeader(reproCommand: string, signature: string): string {
  return [
    'import { expect, test } from "bun:test";',
    'import { handleRequest } from "../src/server";',
    "",
    `const reproRequest = ${JSON.stringify(reproCommand)};`,
    `const failureSignature = ${JSON.stringify(signature)};`,
    "void reproRequest;",
    "void failureSignature;",
    "",
  ].join("\n");
}

const REGRESSION_FIXTURE_MANIFEST: Record<LeakyServiceIncidentClass, FixtureManifestEntry> = {
  [LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer]: {
    fixtureId: "leaky-service.missing-customer.v1",
    contractSource: "leaky-service.valid-create.status-201",
    matches: (incident) => incident.fingerprint.route === "POST /orders" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleCreate"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("missing customer never crashes the create route", async () => {
  const response = await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ sku: "REPRO-CUSTOMER", qty: 1, priceCents: 100 }] }),
  }));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.invalidSince]: {
    fixtureId: "leaky-service.invalid-since.v1",
    contractSource: "leaky-service.valid-list.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /orders" &&
      incident.fingerprint.errName === "RangeError" &&
      incident.fingerprint.topFrame.includes("handleList"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("invalid since never crashes the list route", async () => {
  const response = await handleRequest(new Request("http://leaky-service.test/orders?since=last-week"));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout]: {
    fixtureId: "leaky-service.shipping-timeout.v1",
    contractSource: "leaky-service.valid-ship.status-200",
    matches: (incident) => incident.fingerprint.route === "POST /orders/:id/ship" &&
      incident.fingerprint.errName === "Error" &&
      (incident.fingerprint.topFrame.includes("callShippingProvider") ||
        incident.sampleEvents[0]?.err?.message.startsWith("shipping provider timeout") === true),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("provider rejection is handled by the ship route", async () => {
  const create = await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "fixture", name: "Fixture" },
      items: [{ sku: "REPRO-SHIP", qty: 1, priceCents: 100 }],
    }),
  }));
  const body = await create.json() as { id: string };
  let unhandled: unknown;
  const capture = (reason: unknown) => { unhandled = reason; };
  process.once("unhandledRejection", capture);
  try {
    const response = await handleRequest(
      new Request(\`http://leaky-service.test/orders/\${body.id}/ship\`, { method: "POST" }),
      { shippingProvider: async () => { throw new Error("provider timeout"); } },
    );
    await Bun.sleep(10);
    expect(response.status).toBeLessThan(500);
    expect(unhandled).toBeUndefined();
  } finally {
    process.off("unhandledRejection", capture);
  }
});
`,
  },
};

function fixturePlan(
  incidentClass: LeakyServiceIncidentClass,
  incident: Incident,
  reproCommand: string,
): RegressionFixturePlan | null {
  const entry = REGRESSION_FIXTURE_MANIFEST[incidentClass];
  if (!entry.matches(incident)) return null;
  const relativePath = `apps/leaky-service/test/bug-loop-${incidentClass.replace("leaky-service.", "")}-${incident.fingerprint.hash}.test.ts`;
  return {
    metadata: {
      fixtureId: entry.fixtureId,
      incidentClass,
      contractSources: [entry.contractSource],
    },
    spec: {
      warranted: true,
      reason: `Application manifest fixture ${entry.fixtureId}`,
      mustPin: [
        {
          claim: `the ${incident.fingerprint.errName} failure signature is absent`,
          class: "signature-absence",
        },
        {
          claim: "the response stays outside the 5xx status-code class",
          class: "status-class",
        },
      ],
      mustNotPin: ["exact response message text", "timestamps", "generated IDs"],
      suggestedLocation: relativePath,
    },
    async write(worktreeDir) {
      const path = join(worktreeDir, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.source(incident, reproCommand), "utf8");
      return {
        description: `Generated ${entry.fixtureId} from the application manifest.`,
        filesChanged: [relativePath],
      };
    },
  };
}

export const leakyServiceRegressionTestStrategy: RegressionTestStrategy = {
  prepare(input) {
    if (!AUTHORIZED_CLASSES.includes(input.incidentClass as LeakyServiceIncidentClass)) return null;
    return fixturePlan(
      input.incidentClass as LeakyServiceIncidentClass,
      input.incident,
      input.repro.command,
    );
  },
};

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
    testScope: ["apps/leaky-service/test"],
    worktreeRoot: ".worktrees",
    maxFixAttempts: 2,
    ...(input.incidentConcurrency === undefined
      ? {}
      : { incidentConcurrency: input.incidentConcurrency }),
    fixer: input.fixer,
    contractRegistry: LEAKY_SERVICE_CONTRACTS.map((contract) => ({ ...contract })),
    invariantWarnPrefixes: ["order total negative"],
    workload: {
      benchmarkId: "leaky-service-seeded-v1",
      seed: 42,
      caseCount: 50,
    },
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

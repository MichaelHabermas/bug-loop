import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readNewEvents } from "./logtail";
import { runProcess } from "./process";
import type { Incident, TriageState } from "./types";

export interface CheckResult {
  passes: boolean;
  detail: string;
}

export interface VerifyReproInput {
  worktreeDir: string;
  incident: Incident;
}

export interface VerifyRunner {
  verifyRepro(input: VerifyReproInput): Promise<CheckResult>;
  runTests(worktreeDir: string): Promise<CheckResult>;
  runTypecheck(worktreeDir: string): Promise<CheckResult>;
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
    return {
      completed: true,
      evidence: `HTTP ${response.status}\n${(await response.text()).slice(0, 500)}`,
    };
  }
  if (route === "POST /orders") {
    const response = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ sku: "REPRO-CUSTOMER", qty: 1, priceCents: 100 }],
      }),
    });
    return {
      completed: true,
      evidence: `HTTP ${response.status}\n${(await response.text()).slice(0, 500)}`,
    };
  }
  if (route === "POST /orders/:id/ship") {
    const create = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "bug-loop-verify", name: "Bug Loop" },
        items: [{ sku: "REPRO-SHIP", qty: 1, priceCents: 100 }],
      }),
    });
    const value: unknown = await create.json();
    if (typeof value !== "object" || value === null) {
      return {
        completed: false,
        evidence: `HTTP ${create.status}\ncreate response did not contain an object`,
      };
    }
    const id = (value as Record<string, unknown>)["id"];
    if (typeof id !== "string") {
      return {
        completed: false,
        evidence: `HTTP ${create.status}\ncreate response did not contain an order id`,
      };
    }
    const ship = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, {
      method: "POST",
    });
    await Bun.sleep(150);
    return {
      completed: true,
      evidence: `create HTTP ${create.status}; ship HTTP ${ship.status}\n${(await ship.text()).slice(0, 500)}`,
    };
  }
  throw new Error(`no verifier reproduction for ${route}`);
}

function failureSignaturePresent(
  incident: Incident,
  events: Awaited<ReturnType<typeof readNewEvents>>["events"],
): boolean {
  if (incident.fingerprint.route === "POST /orders/:id/ship") {
    return events.some((event) => event.msg === "unhandledRejection");
  }
  return events.some(
    (event) =>
      event.err?.name === incident.fingerprint.errName &&
      event.route === incident.fingerprint.route,
  );
}

export function reproCheckPasses(
  requestCompleted: boolean,
  signaturePresent: boolean,
): boolean {
  return requestCompleted && !signaturePresent;
}

function outputTail(output: string): string {
  return output.split("\n").slice(-12).join("\n").trim();
}

export class RealVerifyRunner implements VerifyRunner {
  async verifyRepro(input: VerifyReproInput): Promise<CheckResult> {
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

  async runTests(worktreeDir: string): Promise<CheckResult> {
    const result = await runProcess(["bun", "test"], {
      cwd: worktreeDir,
      env: {
        ...Bun.env,
        PORT: "0",
        LOG_PATH: join(worktreeDir, "logs", "verify-tests.jsonl"),
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const pass = combined.match(/\b(\d+) pass\b/)?.[1];
    const fail = combined.match(/\b(\d+) fail\b/)?.[1];
    const summary = pass !== undefined
      ? `${pass} pass, ${fail ?? "0"} fail`
      : outputTail(combined);
    return { passes: result.exitCode === 0, detail: summary };
  }

  async runTypecheck(worktreeDir: string): Promise<CheckResult> {
    const result = await runProcess(["bun", "run", "typecheck"], { cwd: worktreeDir });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    return {
      passes: result.exitCode === 0,
      detail: combined ? outputTail(combined) : "TypeScript: No errors found",
    };
  }
}

async function safeCheck(check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check();
  } catch (error: unknown) {
    return {
      passes: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function verifyWithRunner(
  state: TriageState,
  runner: VerifyRunner,
): Promise<Partial<TriageState>> {
  const incident = state.activeIncident;
  const worktreeDir = state.worktreeDir;
  if (!incident || !worktreeDir) {
    throw new Error("verify requires activeIncident and worktreeDir");
  }
  const repro = await safeCheck(() => runner.verifyRepro({ worktreeDir, incident }));
  const tests = await safeCheck(() => runner.runTests(worktreeDir));
  const typecheck = await safeCheck(() => runner.runTypecheck(worktreeDir));
  const filesChanged = state.activeFix?.filesChanged ?? [];
  const scopePasses = filesChanged.length > 0 && filesChanged.every(
    (path) => path.startsWith("apps/leaky-service/src/"),
  );
  const verified = scopePasses && repro.passes && tests.passes && typecheck.passes;
  const detail = [
    `scope: ${scopePasses ? "pass" : "fail"} - ${filesChanged.join(", ") || "no changed files recorded"}`,
    `repro: ${repro.passes ? "pass" : "fail"} - ${repro.detail}`,
    `tests: ${tests.passes ? "pass" : "fail"} - ${tests.detail}`,
    `typecheck: ${typecheck.passes ? "pass" : "fail"} - ${typecheck.detail}`,
  ].join("\n");
  const result = {
    verified,
    scopePasses,
    reproPasses: repro.passes,
    testsPass: tests.passes,
    typecheckPasses: typecheck.passes,
    reproEvidence: repro.detail,
    testSummary: tests.detail,
    typecheckDetail: typecheck.detail,
    detail,
  };
  return {
    activeVerify: result,
    verifyResults: [...(state.verifyResults ?? []), result],
    retryCount: verified ? state.retryCount : state.retryCount + 1,
  };
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Incident,
  IncidentTriage,
  LogEvent,
  ReproResult,
  TriageState,
} from "@bug-loop/shared";
import { FINGERPRINT_MARKER, fingerprintEvent } from "@bug-loop/shared";
import {
  buildIssueInput,
  dedupeEvents,
  dedupeWithLookup,
  detectWithClassifier,
  routeWithClassifier,
  ticketNode,
  ticketWithCreator,
} from "../src/nodes";
import { HeuristicClassifier } from "../src/classifier";

function errorEvent(reqId: string, line: number): LogEvent {
  return {
    ts: `2026-07-13T12:00:0${line}.000Z`,
    level: "error",
    msg: "handler error",
    reqId,
    route: "POST /orders",
    status: 500,
    err: {
      name: "TypeError",
      message: "undefined customer",
      stack: `TypeError: undefined customer\n    at handleCreate (src/server.ts:${line}:1)`,
    },
  };
}

function incident(sample: LogEvent): Incident {
  return {
    fingerprint: fingerprintEvent(sample),
    sampleEvents: [sample],
    count: 1,
    firstSeen: sample.ts,
    lastSeen: sample.ts,
  };
}

function state(overrides: Partial<TriageState> = {}): TriageState {
  return {
    logPath: "fixture.jsonl",
    events: [],
    actionableEvents: [],
    incidents: [],
    triage: [],
    retryCount: 0,
    errors: [],
    ...overrides,
  };
}

describe("detectNode", () => {
  test("uses the supplied classifier and enriches ship timeout routes", async () => {
    const ship: LogEvent = {
      ts: "2026-07-13T12:00:00.000Z",
      level: "error",
      msg: "unhandledRejection",
      err: { name: "Error", message: "shipping provider timeout for ord_000123" },
    };
    const result = await detectWithClassifier(
      state({ events: [ship, { ...ship, level: "info" }] }),
      new HeuristicClassifier(),
    );
    expect(result.actionableEvents).toHaveLength(1);
    expect(result.actionableEvents?.[0]?.route).toBe("POST /orders/:id/ship");
  });
});

describe("dedupeEvents", () => {
  test("collapses same-cause events despite request and line differences", async () => {
    const result = await dedupeEvents(
      [errorEvent("a", 1), errorEvent("b", 2)],
      async () => null,
    );
    expect(result.all).toHaveLength(1);
    expect(result.all[0]?.count).toBe(2);
    expect(result.fresh).toHaveLength(1);
  });

  test("skips a fingerprint with an existing open ticket", async () => {
    const result = await dedupeEvents([errorEvent("a", 1)], async () => ({
      number: 42,
      url: "https://example.test/issues/42",
    }));
    expect(result.all).toHaveLength(1);
    expect(result.fresh).toHaveLength(0);
  });

  test("retains an existing ticket in the fix queue only when fix mode is enabled", async () => {
    const sample = errorEvent("existing", 1);
    const existing = async () => ({
      number: 3,
      url: "https://example.test/issues/3",
    });
    const fixResult = await dedupeWithLookup(state({
      actionableEvents: [sample],
      config: {
        cursorPath: ".cursor.json",
        fromStart: true,
        baseUrl: "http://localhost:3000",
        fix: true,
      },
    }), existing);
    expect(fixResult.incidents).toHaveLength(1);
    expect(fixResult.triage?.[0]?.ticket?.issueNumber).toBe(3);

    const triageOnly = await dedupeWithLookup(state({
      actionableEvents: [sample],
      config: {
        cursorPath: ".cursor.json",
        fromStart: true,
        baseUrl: "http://localhost:3000",
        fix: false,
      },
    }), existing);
    expect(triageOnly.incidents).toHaveLength(0);
  });
});

describe("routeNode", () => {
  test("routes a reproduced crash to mechanical and a warning to needs-human", async () => {
    const crash = incident(errorEvent("crash", 1));
    const warningEvent: LogEvent = {
      ts: "2026-07-13T12:00:01.000Z",
      level: "warn",
      msg: "order total negative; spec unclear whether discounts may exceed subtotal",
      route: "POST /orders",
    };
    const warning = incident(warningEvent);
    const reproduced: ReproResult = {
      reproduced: true,
      command: "curl example.test",
      evidence: "HTTP 500",
    };
    const triage: IncidentTriage[] = [
      { incident: crash, repro: reproduced },
      { incident: warning, repro: { ...reproduced, reproduced: false } },
    ];
    const result = await routeWithClassifier(
      state({ triage }),
      new HeuristicClassifier(),
    );
    expect(result.triage?.[0]?.route?.kind).toBe("mechanical");
    expect(result.triage?.[1]?.route?.kind).toBe("needs-human");
  });
});

describe("buildIssueInput", () => {
  const originalDryRun = process.env["DRY_RUN"];

  beforeEach(() => {
    process.env["DRY_RUN"] = "1";
  });

  afterEach(() => {
    if (originalDryRun === undefined) delete process.env["DRY_RUN"];
    else process.env["DRY_RUN"] = originalDryRun;
  });

  test("includes the fingerprint marker and files through the DRY_RUN helper", async () => {
    const ticketIncident = incident(errorEvent("ticket", 1));
    const triage: IncidentTriage = {
      incident: ticketIncident,
      repro: { reproduced: true, command: "curl example.test", evidence: "HTTP 500" },
      route: { kind: "mechanical", reason: "Crash reproduced." },
    };
    const input = buildIssueInput(triage);
    expect(input.body).toContain(FINGERPRINT_MARKER(ticketIncident.fingerprint.hash));
    expect(input.body).toContain("curl example.test");
    expect(input.labels).toEqual(["bug-loop", "auto-fix-candidate"]);
    const result = await ticketNode(state({ triage: [triage] }));
    expect(result.triage?.[0]?.ticket?.issueNumber).toBe(9001);
  });

  test("does not commit the cursor when issue creation fails", async () => {
    const cursorPath = join(import.meta.dir, ".tmp-ticket-cursor.json");
    rmSync(cursorPath, { force: true });
    const ticketIncident = incident(errorEvent("failed-ticket", 1));
    const result = await ticketWithCreator(
      state({
        config: {
          cursorPath,
          fromStart: false,
          baseUrl: "http://localhost:3000",
          nextCursorOffset: 123,
        },
        triage: [{
          incident: ticketIncident,
          repro: { reproduced: true, command: "curl example.test", evidence: "HTTP 500" },
          route: { kind: "mechanical", reason: "Crash reproduced." },
        }],
      }),
      async () => {
        throw new Error("gh unavailable");
      },
    );
    expect(result.errors).toEqual([
      `ticket ${ticketIncident.fingerprint.hash}: gh unavailable`,
    ]);
    expect(existsSync(cursorPath)).toBe(false);
  });
});

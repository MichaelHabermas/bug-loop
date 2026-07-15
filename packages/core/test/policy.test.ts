import { describe, expect, test } from "bun:test";
import {
  routeIncident,
  type Incident,
  type RoutingPolicy,
  type RoutingPolicyDecision,
  type UnknownRouteResolver,
} from "../src";

const incident: Incident = {
  fingerprint: {
    hash: "policy-incident",
    errName: "TypeError",
    topFrame: "handleCreate (src/server.ts:1:1)",
    route: "POST /orders",
  },
  sampleEvents: [{
    ts: "2026-07-14T00:00:00.000Z",
    level: "error",
    msg: "handler error",
    route: "POST /orders",
    err: { name: "TypeError", message: "missing customer" },
  }],
  count: 1,
  firstSeen: "2026-07-14T00:00:00.000Z",
  lastSeen: "2026-07-14T00:00:00.000Z",
};

const reproduced = { reproduced: true, command: "curl example.test", evidence: "HTTP 500" };

function policy(decision: RoutingPolicyDecision): RoutingPolicy {
  return {
    authorizedClasses: ["orders.missing-customer"],
    evaluate: () => decision,
  };
}

describe("tri-state routing policy", () => {
  test("preserves all three policy states as discriminated values", () => {
    const decisions: RoutingPolicyDecision[] = [
      { kind: "authorized", incidentClass: "orders.missing-customer", reason: "known contract" },
      { kind: "deny", reason: "product invariant" },
      { kind: "unknown", reason: "unrecognized crash" },
    ];
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "authorized",
      "deny",
      "unknown",
    ]);
    for (const decision of decisions) expect(typeof decision).not.toBe("boolean");
  });

  test("routes an authorized reproduced class mechanically", async () => {
    const route = await routeIncident({
      policy: policy({
        kind: "authorized",
        incidentClass: "orders.missing-customer",
        reason: "known contract",
      }),
      incident,
      repro: reproduced,
    });
    expect(route).toEqual({
      kind: "mechanical",
      incidentClass: "orders.missing-customer",
      reason: "known contract",
    });
  });

  test("never promotes reproduced unknown incidents without an agent mapping", async () => {
    const route = await routeIncident({
      policy: policy({ kind: "unknown", reason: "unrecognized crash" }),
      incident,
      repro: reproduced,
    });
    expect(route.kind).toBe("needs-human");
    expect(route.reason).toContain("unrecognized crash");
  });

  test("uses an agent only for unknowns and validates its class mapping", async () => {
    let calls = 0;
    const resolver: UnknownRouteResolver = {
      async resolve() {
        calls += 1;
        return {
          kind: "authorized",
          incidentClass: "orders.missing-customer",
          reason: "mapped by agent",
          fixBrief: "Guard the missing customer before dereferencing it.",
        };
      },
    };
    const route = await routeIncident({
      policy: policy({ kind: "unknown", reason: "needs classification" }),
      resolver,
      incident,
      repro: reproduced,
    });
    expect(calls).toBe(1);
    expect(route).toMatchObject({
      kind: "mechanical",
      incidentClass: "orders.missing-customer",
      fixBrief: "Guard the missing customer before dereferencing it.",
    });

    const invalid = await routeIncident({
      policy: policy({ kind: "unknown", reason: "needs classification" }),
      resolver: {
        async resolve() {
          return {
            kind: "authorized",
            incidentClass: "invented.class",
            reason: "invented",
          };
        },
      },
      incident,
      repro: reproduced,
    });
    expect(invalid.kind).toBe("needs-human");
    expect(invalid.reason).toContain("not authorized");
  });

  test("deny bypasses the agent and unreproduced authorized incidents stay human", async () => {
    let calls = 0;
    const resolver: UnknownRouteResolver = {
      async resolve() {
        calls += 1;
        return { kind: "needs-human", reason: "human" };
      },
    };
    const denied = await routeIncident({
      policy: policy({ kind: "deny", reason: "policy requires a human" }),
      resolver,
      incident,
      repro: reproduced,
    });
    expect(denied.kind).toBe("needs-human");
    expect(calls).toBe(0);

    const unreproduced = await routeIncident({
      policy: policy({
        kind: "authorized",
        incidentClass: "orders.missing-customer",
        reason: "known contract",
      }),
      resolver,
      incident,
      repro: { ...reproduced, reproduced: false },
    });
    expect(unreproduced.kind).toBe("needs-human");
    expect(calls).toBe(0);
  });
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LEAKY_SERVICE_INCIDENT_CLASSES,
  LEAKY_SERVICE_SEEDED_CASE_COUNT,
  createLeakyServicePipelineConfig,
  leakyServiceRegressionTestStrategy,
  leakyServiceRoutingPolicy,
} from "../src/bug-loop";
import type { Incident } from "@bug-loop/core";

function incident(
  route: string,
  errName: string,
  message: string,
  topFrame: string,
  level: "error" | "warn" = "error",
): Incident {
  return {
    fingerprint: { hash: "fixture-hash", errName, route, topFrame },
    sampleEvents: [{
      ts: "2026-07-14T00:00:00.000Z",
      level,
      msg: level === "warn" ? "order total negative; policy unclear" : "handler error",
      route,
      err: level === "error" ? { name: errName, message } : undefined,
    }],
    count: 1,
    firstSeen: "2026-07-14T00:00:00.000Z",
    lastSeen: "2026-07-14T00:00:00.000Z",
  };
}

const repro = {
  reproduced: true,
  command: "curl -X POST http://service.test/orders",
  evidence: "HTTP 500 TypeError",
};

test("leaky-service policy authorizes eleven mechanical classes and denies its invariant", () => {
  expect(leakyServiceRoutingPolicy.authorizedClasses).toEqual([
    LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
    LEAKY_SERVICE_INCIDENT_CLASSES.invalidSince,
    LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout,
    LEAKY_SERVICE_INCIDENT_CLASSES.itemsIndex,
    LEAKY_SERVICE_INCIDENT_CLASSES.malformedJson,
    LEAKY_SERVICE_INCIDENT_CLASSES.missingReceipt,
    LEAKY_SERVICE_INCIDENT_CLASSES.statsDivZero,
    LEAKY_SERVICE_INCIDENT_CLASSES.shipThenCancel,
    LEAKY_SERVICE_INCIDENT_CLASSES.paginationOverflow,
    LEAKY_SERVICE_INCIDENT_CLASSES.exportHeader,
    LEAKY_SERVICE_INCIDENT_CLASSES.doubleShip,
  ]);
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("POST /orders", "TypeError", "missing customer", "handleCreate"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders", "RangeError", "invalid since", "handleList"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.invalidSince,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident(
      "POST /orders/:id/ship",
      "Error",
      "shipping provider timeout for order-1",
      "callShippingProvider",
    ),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders/:id/items", "TypeError", "reading 'sku'", "handleGetItems"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.itemsIndex,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("POST /orders/import", "SyntaxError", "JSON Parse error", "handleImport"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.malformedJson,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders/:id/receipt", "TypeError", "reading 'id'", "handleReceipt"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingReceipt,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /stats/orders", "TypeError", "reading 'totalCents'", "handleStats"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.statsDivZero,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident(
      "POST /orders/:id/cancel",
      "TypeError",
      "reading 'length'",
      "handleCancel",
    ),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.shipThenCancel,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders", "TypeError", "reading 'toFixed'", "handleList"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.paginationOverflow,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders", "TypeError", "reading 'toUpperCase'", "handleList"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.exportHeader,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("POST /orders/:id/ship", "TypeError", "reading 'push'", "handleShip"),
    repro,
  })).toMatchObject({
    kind: "authorized",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.doubleShip,
  });
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("POST /orders", "WarnInvariant", "", "unknown", "warn"),
    repro: { ...repro, reproduced: false },
  }).kind).toBe("deny");
  // Unknown-class seeded bugs: reproducible but not policy-authorized.
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident(
      "POST /orders/:id/refund",
      "TypeError",
      "Invalid character",
      "handleRefund",
    ),
    repro,
  }).kind).toBe("unknown");
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("GET /orders/:id/tax", "TypeError", "reading 'toUpperCase'", "handleTax"),
    repro,
  }).kind).toBe("unknown");
  expect(leakyServiceRoutingPolicy.evaluate({
    incident: incident("POST /unknown", "TypeError", "other", "unknown"),
    repro,
  }).kind).toBe("unknown");
});

test("benchmark identity is leaky-service-seeded-v2 with 14 cases", () => {
  expect(LEAKY_SERVICE_SEEDED_CASE_COUNT).toBe(14);
  const config = createLeakyServicePipelineConfig({
    cursorPath: "/tmp/cursor.json",
    baseUrl: "http://127.0.0.1:1",
    fixer: "grok",
  });
  expect(config.workload).toMatchObject({
    benchmarkId: "leaky-service-seeded-v2",
    seed: 42,
    caseCount: 14,
  });
});

test("regression fixture metadata and source are derived from the manifest", async () => {
  const target = incident("POST /orders", "TypeError", "missing customer", "handleCreate");
  const plan = leakyServiceRegressionTestStrategy.prepare({
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
    incident: target,
    repro,
  });
  expect(plan).not.toBeNull();
  expect(plan?.metadata).toEqual({
    fixtureId: "leaky-service.missing-customer.v1",
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
    contractSources: ["leaky-service.valid-create.status-201"],
  });
  expect(plan?.spec.mustPin).toContainEqual({
    claim: "the TypeError failure signature is absent",
    class: "signature-absence",
  });

  const root = await mkdtemp(join(tmpdir(), "bug-loop-fixture-"));
  try {
    const written = await plan?.write(root);
    expect(written?.filesChanged).toEqual([
      "apps/leaky-service/test/bug-loop-missing-customer-fixture-hash.test.ts",
    ]);
    const source = await readFile(join(root, written?.filesChanged[0] ?? ""), "utf8");
    expect(source).toContain(repro.command);
    expect(source).toContain("TypeError");
    expect(source).toContain("expect(response.status).toBeLessThan(500)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("regression strategy declines unsupported shapes instead of inventing metadata", () => {
  expect(leakyServiceRegressionTestStrategy.prepare({
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingCustomer,
    incident: incident("GET /orders", "TypeError", "mismatch", "unknown"),
    repro,
  })).toBeNull();
  expect(leakyServiceRegressionTestStrategy.prepare({
    incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.shippingTimeout,
    incident: incident("POST /orders/:id/ship", "Error", "other failure", "unknown"),
    repro,
  })).toBeNull();
  // Unknown-class bugs have no manifest entry even if someone invents a class name.
  expect(leakyServiceRegressionTestStrategy.prepare({
    incidentClass: "leaky-service.refund-token",
    incident: incident(
      "POST /orders/:id/refund",
      "TypeError",
      "Invalid character",
      "handleRefund",
    ),
    repro,
  })).toBeNull();
});

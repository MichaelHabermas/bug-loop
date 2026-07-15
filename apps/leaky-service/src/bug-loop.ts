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
  {
    id: "leaky-service.valid-items.status-200",
    statement: "A valid get-order-items request returns HTTP 200.",
  },
  {
    id: "leaky-service.valid-import.status-201",
    statement: "A valid import-order request returns HTTP 201.",
  },
  {
    id: "leaky-service.valid-receipt.status-200",
    statement: "A valid get-receipt request for an existing order returns HTTP 200.",
  },
  {
    id: "leaky-service.valid-stats.status-200",
    statement: "A valid stats request when orders exist returns HTTP 200.",
  },
  {
    id: "leaky-service.valid-cancel.status-200",
    statement: "A valid cancel of a pending order returns HTTP 200.",
  },
] as const;

export const LEAKY_SERVICE_INCIDENT_CLASSES = {
  missingCustomer: "leaky-service.missing-customer",
  invalidSince: "leaky-service.invalid-since",
  shippingTimeout: "leaky-service.shipping-timeout",
  itemsIndex: "leaky-service.items-index",
  malformedJson: "leaky-service.malformed-json",
  missingReceipt: "leaky-service.missing-receipt",
  statsDivZero: "leaky-service.stats-div-zero",
  shipThenCancel: "leaky-service.ship-then-cancel",
  paginationOverflow: "leaky-service.pagination-overflow",
  exportHeader: "leaky-service.export-header",
  doubleShip: "leaky-service.double-ship",
} as const;

type LeakyServiceIncidentClass =
  typeof LEAKY_SERVICE_INCIDENT_CLASSES[keyof typeof LEAKY_SERVICE_INCIDENT_CLASSES];

const AUTHORIZED_CLASSES: readonly LeakyServiceIncidentClass[] = [
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
];

/** Number of seeded benchmark incidents (3 original mechanical + 1 deny + 8 new mechanical + 2 unknown). */
export const LEAKY_SERVICE_SEEDED_CASE_COUNT = 14;

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
  if (
    fingerprint.route === "GET /orders/:id/items" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleGetItems")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.itemsIndex,
      reason: "The unguarded items-index crash matches the application-owned get-items contract.",
    };
  }
  if (
    fingerprint.route === "POST /orders/import" && fingerprint.errName === "SyntaxError" &&
    fingerprint.topFrame.includes("handleImport")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.malformedJson,
      reason: "The malformed-import crash matches the application-owned import-order contract.",
    };
  }
  if (
    fingerprint.route === "GET /orders/:id/receipt" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleReceipt")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.missingReceipt,
      reason: "The missing-receipt crash matches the application-owned get-receipt contract.",
    };
  }
  if (
    fingerprint.route === "GET /stats/orders" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleStats")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.statsDivZero,
      reason: "The empty-stats crash matches the application-owned stats contract.",
    };
  }
  if (
    fingerprint.route === "POST /orders/:id/cancel" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleCancel")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.shipThenCancel,
      reason: "The ship-then-cancel crash matches the application-owned cancel-order contract.",
    };
  }
  if (
    fingerprint.route === "GET /orders" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleList")
  ) {
    // Distinguish pagination (TypeError) from invalid-since (RangeError).
    if (sample?.err?.message.includes("toFixed") === true ||
      fingerprint.topFrame.includes("handleList")) {
      // Export-header also hits handleList with TypeError; disambiguate via message/region.
      if (sample?.err?.message.toLowerCase().includes("region") === true ||
        sample?.err?.message.toLowerCase().includes("touppercase") === true) {
        return {
          kind: "authorized",
          incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.exportHeader,
          reason: "The export-header crash matches the application-owned list-orders contract.",
        };
      }
      return {
        kind: "authorized",
        incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.paginationOverflow,
        reason: "The pagination-overflow crash matches the application-owned list-orders contract.",
      };
    }
  }
  if (
    fingerprint.route === "POST /orders/:id/ship" && fingerprint.errName === "TypeError" &&
    fingerprint.topFrame.includes("handleShip")
  ) {
    return {
      kind: "authorized",
      incidentClass: LEAKY_SERVICE_INCIDENT_CLASSES.doubleShip,
      reason: "The double-ship crash matches the application-owned ship-order contract.",
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
  [LEAKY_SERVICE_INCIDENT_CLASSES.itemsIndex]: {
    fixtureId: "leaky-service.items-index.v1",
    contractSource: "leaky-service.valid-items.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /orders/:id/items" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleGetItems"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("out-of-range item index never crashes the items route", async () => {
  const create = await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "fixture", name: "Fixture" },
      items: [{ sku: "REPRO-ITEM", qty: 1, priceCents: 100 }],
    }),
  }));
  const body = await create.json() as { id: string };
  const response = await handleRequest(
    new Request(\`http://leaky-service.test/orders/\${body.id}/items?index=99\`),
  );
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.malformedJson]: {
    fixtureId: "leaky-service.malformed-json.v1",
    contractSource: "leaky-service.valid-import.status-201",
    matches: (incident) => incident.fingerprint.route === "POST /orders/import" &&
      incident.fingerprint.errName === "SyntaxError" &&
      incident.fingerprint.topFrame.includes("handleImport"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("malformed import body never crashes the import route", async () => {
  const response = await handleRequest(new Request("http://leaky-service.test/orders/import", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{not-json",
  }));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.missingReceipt]: {
    fixtureId: "leaky-service.missing-receipt.v1",
    contractSource: "leaky-service.valid-receipt.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /orders/:id/receipt" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleReceipt"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("missing order receipt never crashes with 5xx", async () => {
  const response = await handleRequest(
    new Request("http://leaky-service.test/orders/ord_missing/receipt"),
  );
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.statsDivZero]: {
    fixtureId: "leaky-service.stats-div-zero.v1",
    contractSource: "leaky-service.valid-stats.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /stats/orders" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleStats"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("empty stats never crashes the stats route", async () => {
  const response = await handleRequest(new Request("http://leaky-service.test/stats/orders"));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.shipThenCancel]: {
    fixtureId: "leaky-service.ship-then-cancel.v1",
    contractSource: "leaky-service.valid-cancel.status-200",
    matches: (incident) => incident.fingerprint.route === "POST /orders/:id/cancel" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleCancel"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("cancel after ship never crashes the cancel route", async () => {
  const create = await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "fixture", name: "Fixture" },
      items: [{ sku: "REPRO-CANCEL", qty: 1, priceCents: 100 }],
    }),
  }));
  const body = await create.json() as { id: string };
  await handleRequest(
    new Request(\`http://leaky-service.test/orders/\${body.id}/ship\`, { method: "POST" }),
    { shippingProvider: async () => ({ trackingNumber: "TRK-OK" }) },
  );
  const response = await handleRequest(
    new Request(\`http://leaky-service.test/orders/\${body.id}/cancel\`, { method: "POST" }),
  );
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.paginationOverflow]: {
    fixtureId: "leaky-service.pagination-overflow.v1",
    contractSource: "leaky-service.valid-list.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /orders" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleList") &&
      incident.sampleEvents[0]?.err?.message.toLowerCase().includes("region") !== true &&
      incident.sampleEvents[0]?.err?.message.toLowerCase().includes("touppercase") !== true,
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("deep list pages never crash the list route", async () => {
  for (let i = 0; i < 21; i += 1) {
    await handleRequest(new Request("http://leaky-service.test/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: \`p\${i}\`, name: "Pager" },
        items: [{ sku: "PAGE", qty: 1, priceCents: 100 }],
      }),
    }));
  }
  const response = await handleRequest(new Request("http://leaky-service.test/orders?page=2"));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.exportHeader]: {
    fixtureId: "leaky-service.export-header.v1",
    contractSource: "leaky-service.valid-list.status-200",
    matches: (incident) => incident.fingerprint.route === "GET /orders" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleList") &&
      (incident.sampleEvents[0]?.err?.message.toLowerCase().includes("region") === true ||
        incident.sampleEvents[0]?.err?.message.toLowerCase().includes("touppercase") === true),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("export header never crashes the list route", async () => {
  await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "export", name: "Exporter" },
      items: [{ sku: "EXP", qty: 1, priceCents: 100 }],
    }),
  }));
  const response = await handleRequest(new Request("http://leaky-service.test/orders", {
    headers: { "x-export": "full" },
  }));
  expect(response.status).toBeLessThan(500);
});
`,
  },
  [LEAKY_SERVICE_INCIDENT_CLASSES.doubleShip]: {
    fixtureId: "leaky-service.double-ship.v1",
    contractSource: "leaky-service.valid-ship.status-200",
    matches: (incident) => incident.fingerprint.route === "POST /orders/:id/ship" &&
      incident.fingerprint.errName === "TypeError" &&
      incident.fingerprint.topFrame.includes("handleShip"),
    source: (incident, command) => `${fixtureHeader(command, incident.fingerprint.errName)}test("second ship never crashes the ship route", async () => {
  const create = await handleRequest(new Request("http://leaky-service.test/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: "fixture", name: "Fixture" },
      items: [{ sku: "REPRO-DBL", qty: 1, priceCents: 100 }],
    }),
  }));
  const body = await create.json() as { id: string };
  const shipInit = { method: "POST" as const };
  const deps = { shippingProvider: async () => ({ trackingNumber: "TRK-OK" }) };
  await handleRequest(new Request(\`http://leaky-service.test/orders/\${body.id}/ship\`, shipInit), deps);
  const response = await handleRequest(
    new Request(\`http://leaky-service.test/orders/\${body.id}/ship\`, shipInit),
    deps,
  );
  expect(response.status).toBeLessThan(500);
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
  const relativePath =
    `apps/leaky-service/test/bug-loop-${incidentClass.replace("leaky-service.", "")}-${incident.fingerprint.hash}.test.ts`;
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
    if (!AUTHORIZED_CLASSES.includes(input.incidentClass as LeakyServiceIncidentClass)) {
      return null;
    }
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
      benchmarkId: "leaky-service-seeded-v2",
      seed: 42,
      caseCount: LEAKY_SERVICE_SEEDED_CASE_COUNT,
    },
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function curlPost(url: string, body?: string, headers: string[] = []): string {
  const headerFlags = headers.map((h) => ` -H ${shellQuote(h)}`).join("");
  const data = body === undefined
    ? ""
    : ` -H 'content-type: application/json' --data ${shellQuote(body)}`;
  return `curl -sS -X POST${headerFlags}${data} ${shellQuote(url)}`;
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

function createBody(sku: string): string {
  return JSON.stringify({
    customer: { id: "bug-loop-repro", name: "Bug Loop" },
    items: [{ sku, qty: 1, priceCents: 100 }],
  });
}

async function createOrderId(baseUrl: string, sku = "REPRO"): Promise<string | null> {
  const createResponse = await fetch(`${baseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: createBody(sku),
  });
  const created: unknown = await createResponse.json();
  if (typeof created !== "object" || created === null) return null;
  const id = (created as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : null;
}

function buildCommand(baseUrl: string, incident: Incident, sample: LogEvent): string | null {
  const route = incident.fingerprint.route;
  if (route === "POST /orders/:id/ship") {
    if (incident.fingerprint.errName === "TypeError") {
      const createCommand = curlPost(`${baseUrl}/orders`, shipBody());
      const shipUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/ship");
      return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST ${shipUrl}; curl -sS -X POST ${shipUrl}`;
    }
    const createCommand = curlPost(`${baseUrl}/orders`, shipBody());
    const shipUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/ship");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST ${shipUrl}`;
  }
  if (route === "GET /orders") {
    if (incident.fingerprint.errName === "RangeError") {
      return `curl -sS ${shellQuote(`${baseUrl}/orders?since=last-week`)}`;
    }
    if (
      sample.err?.message.toLowerCase().includes("region") === true ||
      sample.err?.message.toLowerCase().includes("touppercase") === true
    ) {
      const createCommand = curlPost(`${baseUrl}/orders`, createBody("REPRO-EXPORT"));
      return `${createCommand}; curl -sS -H 'x-export: full' ${shellQuote(`${baseUrl}/orders`)}`;
    }
    const creates = Array.from({ length: 21 }, (_, i) =>
      curlPost(`${baseUrl}/orders`, createBody(`REPRO-PAGE-${i}`))
    ).join("; ");
    return `${creates}; curl -sS ${shellQuote(`${baseUrl}/orders?page=2`)}`;
  }
  if (route === "POST /orders") {
    return curlPost(
      `${baseUrl}/orders`,
      sample.level === "warn" ? discountBody() : missingCustomerBody(),
    );
  }
  if (route === "GET /orders/:id/items") {
    const createCommand = curlPost(`${baseUrl}/orders`, createBody("REPRO-ITEM"));
    const itemsUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/items?index=99");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS ${itemsUrl}`;
  }
  if (route === "POST /orders/import") {
    return `curl -sS -X POST -H 'content-type: text/plain' --data '{not-json' ${shellQuote(`${baseUrl}/orders/import`)}`;
  }
  if (route === "GET /orders/:id/receipt") {
    return `curl -sS ${shellQuote(`${baseUrl}/orders/ord_missing/receipt`)}`;
  }
  if (route === "GET /stats/orders") {
    return `curl -sS ${shellQuote(`${baseUrl}/stats/orders`)}`;
  }
  if (route === "POST /orders/:id/cancel") {
    const createCommand = curlPost(`${baseUrl}/orders`, createBody("REPRO-CANCEL"));
    const shipUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/ship");
    const cancelUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/cancel");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST ${shipUrl}; curl -sS -X POST ${cancelUrl}`;
  }
  if (route === "POST /orders/:id/refund") {
    const createCommand = curlPost(`${baseUrl}/orders`, createBody("REPRO-REFUND"));
    const refundUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/refund");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST -H 'authorization: Bearer not-a-jwt' ${refundUrl}`;
  }
  if (route === "GET /orders/:id/tax") {
    const createCommand = curlPost(`${baseUrl}/orders`, createBody("REPRO-TAX"));
    const taxUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/tax");
    return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS ${taxUrl}`;
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
  const route = input.incident.fingerprint.route;
  const errName = input.incident.fingerprint.errName;

  if (route === "POST /orders/:id/ship" && errName === "Error") {
    return reproduceShip(input);
  }
  if (route === "POST /orders/:id/ship" && errName === "TypeError") {
    const id = await createOrderId(input.baseUrl, "REPRO-DBL");
    if (!id) return { reproduced: false, evidence: "Create failed." };
    await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    await Bun.sleep(50);
    const response = await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/ship`, {
      method: "POST",
    });
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
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
  if (route === "GET /orders" && errName === "RangeError") {
    const response = await fetch(`${input.baseUrl}/orders?since=last-week`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders" && errName === "TypeError") {
    if (
      input.sample.err?.message.toLowerCase().includes("region") === true ||
      input.sample.err?.message.toLowerCase().includes("touppercase") === true
    ) {
      await createOrderId(input.baseUrl, "REPRO-EXPORT");
      const response = await fetch(`${input.baseUrl}/orders`, {
        headers: { "x-export": "full" },
      });
      return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
    }
    for (let i = 0; i < 21; i += 1) {
      await createOrderId(input.baseUrl, `REPRO-PAGE-${i}`);
    }
    const response = await fetch(`${input.baseUrl}/orders?page=2`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders") {
    const response = await fetch(`${input.baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: missingCustomerBody(),
    });
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders/:id/items") {
    const id = await createOrderId(input.baseUrl, "REPRO-ITEM");
    if (!id) return { reproduced: false, evidence: "Create failed." };
    const response = await fetch(
      `${input.baseUrl}/orders/${encodeURIComponent(id)}/items?index=99`,
    );
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/import") {
    const response = await fetch(`${input.baseUrl}/orders/import`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not-json",
    });
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders/:id/receipt") {
    const response = await fetch(`${input.baseUrl}/orders/ord_missing/receipt`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "GET /stats/orders") {
    const response = await fetch(`${input.baseUrl}/stats/orders`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/:id/cancel") {
    const id = await createOrderId(input.baseUrl, "REPRO-CANCEL");
    if (!id) return { reproduced: false, evidence: "Create failed." };
    await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    await Bun.sleep(50);
    const response = await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/:id/refund") {
    const id = await createOrderId(input.baseUrl, "REPRO-REFUND");
    if (!id) return { reproduced: false, evidence: "Create failed." };
    const response = await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/refund`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders/:id/tax") {
    const id = await createOrderId(input.baseUrl, "REPRO-TAX");
    if (!id) return { reproduced: false, evidence: "Create failed." };
    const response = await fetch(`${input.baseUrl}/orders/${encodeURIComponent(id)}/tax`);
    return { reproduced: response.status >= 500, evidence: await responseEvidence(response) };
  }
  return { reproduced: false, evidence: `No reproduction derived for ${route}` };
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
  const errName = incident.fingerprint.errName;
  const sample = incident.sampleEvents[0];

  if (route === "GET /orders" && errName === "RangeError") {
    const response = await fetch(`${baseUrl}/orders?since=last-week`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders" && errName === "TypeError") {
    if (
      sample?.err?.message.toLowerCase().includes("region") === true ||
      sample?.err?.message.toLowerCase().includes("touppercase") === true
    ) {
      await createOrderId(baseUrl, "VERIFY-EXPORT");
      const response = await fetch(`${baseUrl}/orders`, { headers: { "x-export": "full" } });
      return { completed: true, evidence: await responseEvidence(response) };
    }
    for (let i = 0; i < 21; i += 1) {
      await createOrderId(baseUrl, `VERIFY-PAGE-${i}`);
    }
    const response = await fetch(`${baseUrl}/orders?page=2`);
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
  if (route === "POST /orders/:id/ship" && errName === "Error") {
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
  if (route === "POST /orders/:id/ship" && errName === "TypeError") {
    const id = await createOrderId(baseUrl, "VERIFY-DBL");
    if (!id) return { completed: false, evidence: "create failed" };
    await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    await Bun.sleep(50);
    const ship = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    return { completed: true, evidence: await responseEvidence(ship) };
  }
  if (route === "GET /orders/:id/items") {
    const id = await createOrderId(baseUrl, "VERIFY-ITEM");
    if (!id) return { completed: false, evidence: "create failed" };
    const response = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/items?index=99`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/import") {
    const response = await fetch(`${baseUrl}/orders/import`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not-json",
    });
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders/:id/receipt") {
    const response = await fetch(`${baseUrl}/orders/ord_missing/receipt`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "GET /stats/orders") {
    const response = await fetch(`${baseUrl}/stats/orders`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/:id/cancel") {
    const id = await createOrderId(baseUrl, "VERIFY-CANCEL");
    if (!id) return { completed: false, evidence: "create failed" };
    await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, { method: "POST" });
    await Bun.sleep(50);
    const response = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "POST /orders/:id/refund") {
    const id = await createOrderId(baseUrl, "VERIFY-REFUND");
    if (!id) return { completed: false, evidence: "create failed" };
    const response = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/refund`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt" },
    });
    return { completed: true, evidence: await responseEvidence(response) };
  }
  if (route === "GET /orders/:id/tax") {
    const id = await createOrderId(baseUrl, "VERIFY-TAX");
    if (!id) return { completed: false, evidence: "create failed" };
    const response = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/tax`);
    return { completed: true, evidence: await responseEvidence(response) };
  }
  return { completed: false, evidence: `no verifier reproduction for ${route}` };
}

function failureSignaturePresent(incident: Incident, events: LogEvent[]): boolean {
  if (
    incident.fingerprint.route === "POST /orders/:id/ship" &&
    incident.fingerprint.errName === "Error"
  ) {
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

function canonicalizeLoggedRoute(route: string | undefined): string | undefined {
  if (route === undefined) return undefined;
  return route
    .replace(/^POST \/orders\/[^/]+\/ship$/, "POST /orders/:id/ship")
    .replace(/^POST \/orders\/[^/]+\/cancel$/, "POST /orders/:id/cancel")
    .replace(/^POST \/orders\/[^/]+\/refund$/, "POST /orders/:id/refund")
    .replace(/^GET \/orders\/[^/]+\/items$/, "GET /orders/:id/items")
    .replace(/^GET \/orders\/[^/]+\/receipt$/, "GET /orders/:id/receipt")
    .replace(/^GET \/orders\/[^/]+\/tax$/, "GET /orders/:id/tax")
    .replace(/^GET \/orders\/[^/]+$/, "GET /orders/:id")
    .replace(/^POST \/orders\/[^/]+$/, "POST /orders/:id");
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
    const route = canonicalizeLoggedRoute(event.route);
    if (route !== undefined && route !== event.route) {
      return { ...event, route };
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

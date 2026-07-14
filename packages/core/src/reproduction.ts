import { readNewEvents } from "./logtail";
import type { Incident, LogEvent, ReproResult } from "./types";

export interface ReproduceInput {
  logPath: string;
  baseUrl: string;
  incident: Incident;
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

function shipReproCommand(baseUrl: string): string {
  const createCommand = curlPost(`${baseUrl}/orders`, shipBody());
  const shipUrl = shellQuote(`${baseUrl}/orders/`) + '"$order_id"' + shellQuote("/ship");
  return `order_id=$(${createCommand} | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p'); curl -sS -X POST ${shipUrl}`;
}

export function buildReproCommand(
  baseUrl: string,
  incident: Incident,
  sample: LogEvent,
): string {
  if (incident.fingerprint.route === "POST /orders/:id/ship") {
    return shipReproCommand(baseUrl);
  }
  if (incident.fingerprint.route === "GET /orders") {
    return `curl -sS ${shellQuote(`${baseUrl}/orders?since=last-week`)}`;
  }
  return curlPost(
    `${baseUrl}/orders`,
    sample.level === "warn" ? discountBody() : missingCustomerBody(),
  );
}

async function responseEvidence(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 500);
  return `HTTP ${response.status}${body ? `\n${body}` : ""}`;
}

async function reproduceShip(input: ReproduceInput, command: string): Promise<ReproResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const before = { offset: Bun.file(input.logPath).size };
  const createResponse = await fetch(`${baseUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: shipBody(),
  });
  const created: unknown = await createResponse.json();
  if (typeof created !== "object" || created === null) {
    return { reproduced: false, command, evidence: "Create response did not contain an order." };
  }
  const id = (created as Record<string, unknown>)["id"];
  if (typeof id !== "string") {
    return { reproduced: false, command, evidence: "Create response did not contain an order id." };
  }
  const shipResponse = await fetch(`${baseUrl}/orders/${encodeURIComponent(id)}/ship`, {
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
    command,
    evidence: timeout
      ? `HTTP ${shipResponse.status}\n${JSON.stringify(timeout)}`
      : `HTTP ${shipResponse.status}\nNo matching timeout log appeared.`,
  };
}

export async function reproduceIncident(input: ReproduceInput): Promise<ReproResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const sample = input.incident.sampleEvents[0];
  if (!sample) {
    return { reproduced: false, command: "", evidence: "Incident has no sample log." };
  }
  const command = buildReproCommand(baseUrl, input.incident, sample);

  try {
    if (input.incident.fingerprint.route === "POST /orders/:id/ship") {
      return await reproduceShip(input, command);
    }
    if (sample.level === "warn") {
      const response = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: discountBody(),
      });
      return {
        reproduced: false,
        command,
        evidence: `Invariant request completed but remains a product-policy question.\n${await responseEvidence(response)}`,
      };
    }
    if (input.incident.fingerprint.route === "GET /orders") {
      const response = await fetch(`${baseUrl}/orders?since=last-week`);
      return {
        reproduced: response.status >= 500,
        command,
        evidence: await responseEvidence(response),
      };
    }
    if (input.incident.fingerprint.route === "POST /orders") {
      const response = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: missingCustomerBody(),
      });
      return {
        reproduced: response.status >= 500,
        command,
        evidence: await responseEvidence(response),
      };
    }
    return {
      reproduced: false,
      command,
      evidence: "No HTTP reproduction is known for this route.",
    };
  } catch (error: unknown) {
    return {
      reproduced: false,
      command,
      evidence: `Service unreachable or request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

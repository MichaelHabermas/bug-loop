/**
 * Verify configured OpenRouter model ids against GET /api/v1/models and print
 * availability + current prompt/completion prices.
 *
 * Runtime-only network (operator machine). Requires OPENROUTER_API_KEY.
 *
 * Usage:
 *   bun run scripts/verify-models.ts [--config scripts/model-sweep.config.json]
 */

import { resolve } from "node:path";
import {
  listOpenRouterModels,
  type OpenRouterModelInfo,
} from "../packages/core/src/openrouter";
import {
  loadModelSweepConfig,
  openRouterModelToOpenCode,
} from "./model-sweep";

function formatPrice(perToken: number | undefined): string {
  if (perToken === undefined) return "n/a";
  // OpenRouter prices are USD per token; show per 1M tokens for readability.
  const perMillion = perToken * 1_000_000;
  return `$${perMillion.toFixed(4)}/MTok`;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  let configPath = resolve("scripts/model-sweep.config.json");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--config requires a path");
      configPath = resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run scripts/verify-models.ts [--config path]\n" +
          "Queries OpenRouter /models and reports availability + prices for the configured list.\n" +
          "Requires OPENROUTER_API_KEY.",
      );
      return;
    }
  }

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required");
  }

  const config = await loadModelSweepConfig(configPath);
  console.log(`Configured models (${config.models.length}) from ${configPath}:`);
  for (const id of config.models) {
    console.log(`  - ${id}  (opencode -m ${openRouterModelToOpenCode(id)})`);
  }
  console.log();
  console.log("Fetching https://openrouter.ai/api/v1/models …");

  const found = await listOpenRouterModels({ apiKey }, config.models);
  const byId = new Map<string, OpenRouterModelInfo>(
    found.map((row) => [row.id, row]),
  );

  let missing = 0;
  console.log();
  console.log(
    "id".padEnd(42) +
      "available".padEnd(12) +
      "prompt".padEnd(16) +
      "completion",
  );
  console.log("-".repeat(86));
  for (const id of config.models) {
    const row = byId.get(id);
    if (row === undefined) {
      missing += 1;
      console.log(
        id.padEnd(42) + "NO".padEnd(12) + "—".padEnd(16) + "—",
      );
      continue;
    }
    console.log(
      id.padEnd(42) +
        "yes".padEnd(12) +
        formatPrice(row.promptPricePerToken).padEnd(16) +
        formatPrice(row.completionPricePerToken),
    );
  }

  console.log();
  if (missing > 0) {
    console.error(
      `${missing} model id(s) not found on OpenRouter. Edit scripts/model-sweep.config.json ` +
        `after checking https://openrouter.ai/api/v1/models — placeholders must be verified before a live run.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("All configured models are available.");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

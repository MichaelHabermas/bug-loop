import { join } from "node:path";
import type { TriageSummary } from "@bug-loop/shared";
import { runAgentSdkPipeline } from "./pipeline";

interface CliArgs {
  fromStart: boolean;
  live: boolean;
  fix: boolean;
  baseUrl: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromStart = false;
  let live = false;
  let fix = false;
  let baseUrl = process.env["BUGLOOP_BASE_URL"] ?? "http://localhost:3000";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-start") fromStart = true;
    else if (arg === "--live") live = true;
    else if (arg === "--fix") fix = true;
    else if (arg === "--base") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base requires a URL");
      baseUrl = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { fromStart, live, fix, baseUrl: baseUrl.replace(/\/$/, "") };
}

export function printSummary(summary: TriageSummary): void {
  const rows: Array<[string, number]> = [
    ["events read", summary.eventsRead],
    ["actionable", summary.actionable],
    ["incidents", summary.incidents],
    ["new", summary.newIncidents],
    ["reproduced", summary.reproduced],
    ["issues filed", summary.issuesFiled],
  ];
  console.log("\nFinal summary");
  console.log("stage          count");
  console.log("--------------------");
  for (const [label, count] of rows) console.log(`${label.padEnd(14)} ${count}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.live) delete process.env["DRY_RUN"];
  else process.env["DRY_RUN"] = "1";

  const result = await runAgentSdkPipeline({
    logPath: join(import.meta.dir, "../../../logs/leaky-service.jsonl"),
    cursorPath: join(import.meta.dir, "../.cursor.json"),
    fromStart: args.fromStart,
    baseUrl: args.baseUrl,
    fix: args.fix,
    live: args.live,
  });
  printSummary(result.summary);
  if (result.state.errors.length > 0) {
    console.error(`Pipeline completed with ${result.state.errors.length} error(s).`);
    for (const error of result.state.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

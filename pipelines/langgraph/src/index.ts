import { resolve } from "node:path";
import { TraceRecorder, type TriageSummary } from "@bug-loop/core";
import { leakyServiceReproStrategy } from "@bug-loop/leaky-service/bug-loop";
import { createInitialState, createTriageGraph } from "./graph";
import { createLangGraphConfig } from "./config";

interface CliArgs {
  fromStart: boolean;
  live: boolean;
  fix: boolean;
  baseUrl: string;
  tracePath?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromStart = false;
  let live = false;
  let fix = false;
  let baseUrl = process.env["BUGLOOP_BASE_URL"] ?? "http://localhost:3000";
  let tracePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-start") {
      fromStart = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--fix") {
      fix = true;
    } else if (arg === "--base") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base requires a URL");
      baseUrl = value;
      index += 1;
    } else if (arg === "--trace") {
      const value = argv[index + 1];
      if (!value) throw new Error("--trace requires a path");
      tracePath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    fromStart,
    live,
    fix,
    baseUrl: baseUrl.replace(/\/$/, ""),
    ...(tracePath === undefined ? {} : { tracePath }),
  };
}

function printSummary(summary: TriageSummary): void {
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
  for (const [label, count] of rows) {
    console.log(`${label.padEnd(14)} ${count}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.live) delete process.env["DRY_RUN"];
  else process.env["DRY_RUN"] = "1";

  const config = createLangGraphConfig(args.baseUrl);
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    config,
    traceRoot: resolve(import.meta.dir, "../../../traces"),
    ...(args.tracePath === undefined ? {} : { outputPath: args.tracePath }),
  });
  const graph = createTriageGraph(config, {
    reproStrategy: leakyServiceReproStrategy,
    recorder,
  });
  const state = createInitialState(config, {
    fromStart: args.fromStart,
    fix: args.fix,
    live: args.live,
  });
  const result = await graph.invoke(state, {
    configurable: { thread_id: crypto.randomUUID() },
  }).finally(() => recorder.finish());
  printSummary(
    result.summary ?? {
      eventsRead: result.events.length,
      actionable: result.actionableEvents.length,
      incidents: result.incidents.length,
      newIncidents: result.incidents.length,
      reproduced: 0,
      issuesFiled: 0,
    },
  );
  if (result.errors.length > 0) {
    console.error(`Pipeline completed with ${result.errors.length} error(s).`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

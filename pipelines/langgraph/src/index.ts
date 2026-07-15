import { resolve } from "node:path";
import {
  resolvePipelineRuntime,
  resolveTraceWorkload,
  runWatchDaemon,
  TraceRecorder,
  watchPassLabel,
  watchTraceOutputPath,
  type TriageSummary,
} from "@bug-loop/core";
import {
  leakyServiceRegressionTestStrategy,
  leakyServiceReproStrategy,
  leakyServiceRoutingPolicy,
} from "@bug-loop/leaky-service/bug-loop";
import { createInitialState, createTriageGraph } from "./graph";
import { createLangGraphConfig } from "./config";

interface CliArgs {
  fromStart: boolean;
  live: boolean;
  fix: boolean;
  watch: boolean;
  baseUrl: string;
  tracePath?: string;
  label?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromStart = false;
  let live = false;
  let fix = false;
  let watch = false;
  let baseUrl = process.env["BUGLOOP_BASE_URL"] ?? "http://localhost:3000";
  let tracePath: string | undefined;
  let label: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-start") {
      fromStart = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--fix") {
      fix = true;
    } else if (arg === "--watch") {
      watch = true;
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
    } else if (arg === "--label") {
      const value = argv[index + 1];
      if (!value) throw new Error("--label requires a name");
      label = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (watch && fromStart) {
    throw new Error("--watch cannot be combined with --from-start (watch continues from the cursor)");
  }
  return {
    fromStart,
    live,
    fix,
    watch,
    baseUrl: baseUrl.replace(/\/$/, ""),
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(label === undefined ? {} : { label }),
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

function applyDryRunEnv(live: boolean): void {
  if (live) delete process.env["DRY_RUN"];
  else process.env["DRY_RUN"] = "1";
}

function summaryFromResult(result: {
  summary?: TriageSummary;
  events: unknown[];
  actionableEvents?: unknown[];
  incidents: unknown[];
}): TriageSummary {
  return result.summary ?? {
    eventsRead: result.events.length,
    actionable: result.actionableEvents?.length ?? 0,
    incidents: result.incidents.length,
    newIncidents: result.incidents.length,
    reproduced: 0,
    issuesFiled: 0,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  applyDryRunEnv(args.live);

  const config = createLangGraphConfig(args.baseUrl);
  const repoRoot = resolve(import.meta.dir, "../../..");
  const graphDeps = {
    reproStrategy: leakyServiceReproStrategy,
    routingPolicy: leakyServiceRoutingPolicy,
    regressionTestStrategy: leakyServiceRegressionTestStrategy,
  };

  if (args.watch) {
    const controller = new AbortController();
    const sessionFixFingerprints = new Set<string>();
    const onSignal = (): void => {
      console.log("\n[watch] shutdown requested — finishing in-flight pass if any");
      controller.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      await runWatchDaemon({
        config,
        signal: controller.signal,
        runPass: async (ctx) => {
          const resolvedRuntime = resolvePipelineRuntime({
            pipeline: "langgraph",
            config,
            mode: {
              fromStart: false,
              fix: args.fix,
              live: args.live,
              watch: true,
            },
          });
          const baseWorkload = await resolveTraceWorkload(config, repoRoot);
          const workload = {
            ...baseWorkload,
            watchSessionId: ctx.watchSessionId,
            watchPass: ctx.passNumber,
          };
          const passLabel = watchPassLabel(args.label, ctx.passNumber);
          const recorder = new TraceRecorder({
            pipeline: "langgraph",
            resolved: resolvedRuntime,
            workload,
            traceRoot: resolve(repoRoot, "traces"),
            ...(args.tracePath === undefined
              ? {}
              : { outputPath: watchTraceOutputPath(args.tracePath, ctx.passNumber) }),
            label: passLabel,
          });
          const graph = createTriageGraph(config, {
            ...graphDeps,
            recorder,
            resolved: resolvedRuntime,
            sessionFixFingerprints,
          });
          const state = createInitialState(config, {
            fromStart: false,
            fix: args.fix,
            live: args.live,
            watch: true,
            commitCursorOffset: ctx.batchEndOffset,
          });
          const result = await graph.invoke(state, {
            configurable: { thread_id: crypto.randomUUID() },
          }).finally(() => recorder.finish());
          const summary = summaryFromResult(result);
          printSummary(summary);
          if (result.errors.length > 0) {
            console.error(`Watch pass ${ctx.passNumber} completed with ${result.errors.length} error(s).`);
            for (const error of result.errors) console.error(`- ${error}`);
          }
          return {
            detail: `events=${summary.eventsRead} new=${summary.newIncidents} issues=${summary.issuesFiled}`,
          };
        },
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }

  const resolvedRuntime = resolvePipelineRuntime({
    pipeline: "langgraph",
    config,
    mode: args,
  });
  const workload = await resolveTraceWorkload(config, repoRoot);
  const recorder = new TraceRecorder({
    pipeline: "langgraph",
    resolved: resolvedRuntime,
    workload,
    traceRoot: resolve(repoRoot, "traces"),
    ...(args.tracePath === undefined ? {} : { outputPath: args.tracePath }),
    ...(args.label === undefined ? {} : { label: args.label }),
  });
  const graph = createTriageGraph(config, {
    ...graphDeps,
    recorder,
    resolved: resolvedRuntime,
  });
  const state = createInitialState(config, {
    fromStart: args.fromStart,
    fix: args.fix,
    live: args.live,
  });
  const result = await graph.invoke(state, {
    configurable: { thread_id: crypto.randomUUID() },
  }).finally(() => recorder.finish());
  printSummary(summaryFromResult(result));
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

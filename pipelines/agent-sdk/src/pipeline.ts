import { resolve } from "node:path";
import {
  buildIssueInput,
  combineCostSamples,
  createAttemptId,
  createCorrelationId,
  createResolvedFixer,
  formatRegressionTestIntent,
  formatPrFilesList,
  findOpenIssueByMarker,
  GitHubClient,
  GitWorktreeOperations,
  groupIncidents,
  heuristicRegressionTestSpec,
  isStructuredActionable,
  readCursor,
  readNewEvents,
  RealVerifyRunner,
  reproduceIncident,
  routeIncident,
  resolvePipelineRuntime,
  resolveTraceWorkload,
  runIncidentWorkers,
  rewritePathsForPrBody,
  TraceRecorder,
  writeCursor,
  type FixAttempt,
  type Fixer,
  type TestWriter,
  type CostSample,
  type IncidentTriage,
  type IncidentResult,
  type IssueDetails,
  type IssueInput,
  type IssueRef,
  type OpenIssue,
  type PRInput,
  type PRRef,
  type PipelineConfig,
  type ReproStrategy,
  type RegressionTestStrategy,
  type RoutingPolicy,
  type TriageRunConfig,
  type TriageState,
  type TriageSummary,
  type VerifyRunner,
  type WorktreeOperations,
} from "@bug-loop/core";
import { ClaudeTriageAgent, type TriageAgent } from "./triage-agent";

const EMPTY_SUMMARY: TriageSummary = {
  eventsRead: 0,
  actionable: 0,
  incidents: 0,
  newIncidents: 0,
  reproduced: 0,
  issuesFiled: 0,
};

export interface AgentSdkPipelineOptions extends TriageRunConfig {
  tracePath?: string;
  label?: string;
  /** Shared across watch-mode passes; written into trace workload metadata. */
  watchSessionId?: string;
  /** 1-based watch pass number for trace workload metadata. */
  watchPass?: number;
}

export interface GitHubOperations {
  listOpenIssues(): Promise<OpenIssue[]>;
  createIssue(input: IssueInput): Promise<IssueRef>;
  readIssue(number: number): Promise<IssueDetails | null>;
  commentIssue(number: number, body: string): Promise<void>;
  replaceIssueLabel(number: number, remove: string, add: string): Promise<void>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export interface PipelineDependencies {
  triageAgent?: TriageAgent;
  fixer?: Fixer;
  createFixer?: () => Fixer;
  testWriter?: TestWriter;
  createTestWriter?: () => TestWriter;
  verifier?: VerifyRunner;
  createVerifier?: () => VerifyRunner;
  worktrees?: WorktreeOperations;
  github?: GitHubOperations;
  reproStrategy?: ReproStrategy;
  routingPolicy?: RoutingPolicy;
  regressionTestStrategy?: RegressionTestStrategy;
  recorder?: TraceRecorder;
  repoRoot?: string;
}

export interface AgentSdkPipelineResult {
  state: TriageState;
  summary: TriageSummary;
}

function initialState(
  pipelineConfig: PipelineConfig,
  options: AgentSdkPipelineOptions,
): TriageState {
  return {
    logPath: pipelineConfig.logPath,
    pipelineConfig,
    events: [],
    actionableEvents: [],
    incidents: [],
    triage: [],
    fixAttempts: [],
    regressionTestAttempts: [],
    verifyResults: [],
    pullRequests: [],
    config: {
      fromStart: options.fromStart,
      fix: options.fix ?? false,
      live: options.live ?? false,
      ...(options.watch === true ? { watch: true } : {}),
    },
    summary: { ...EMPTY_SUMMARY },
    retryCount: 0,
    errors: [],
  };
}

async function ingest(state: TriageState): Promise<void> {
  const config = state.config;
  const pipelineConfig = state.pipelineConfig;
  if (!config || !pipelineConfig) throw new Error("ingest requires pipeline and run config");
  const cursor = config.fromStart ? { offset: 0 } : await readCursor(pipelineConfig.cursorPath);
  const result = await readNewEvents(state.logPath, cursor);
  state.events = result.events;
  state.config = { ...config, nextCursorOffset: result.cursor.offset };
  state.summary = { ...EMPTY_SUMMARY, eventsRead: result.events.length };
  console.log(`[ingest] events=${result.events.length}`);
}

function detect(
  state: TriageState,
  config: PipelineConfig,
  strategy?: ReproStrategy,
): void {
  const actionable = state.events
    .filter((event) => isStructuredActionable(event, config.invariantWarnPrefixes))
    .map((event) => strategy?.normalizeEvent?.(event) ?? event);
  state.actionableEvents = actionable;
  state.summary = { ...(state.summary ?? EMPTY_SUMMARY), actionable: actionable.length };
  console.log(`[detect] actionable=${actionable.length}`);
}

async function dedupe(
  state: TriageState,
  github: GitHubOperations,
): Promise<void> {
  const all = groupIncidents(state.actionableEvents ?? []);
  const openIssues = await github.listOpenIssues();
  const existing = all.map((incident) =>
    findOpenIssueByMarker(openIssues, incident.fingerprint.hash)
  );
  const fresh = all.filter((_, index) => existing[index] === null);
  const config = state.config;
  if (fresh.length === 0 && config?.nextCursorOffset !== undefined) {
    const cursorPath = state.pipelineConfig?.cursorPath;
    if (!cursorPath) throw new Error("dedupe requires pipelineConfig.cursorPath");
    await writeCursor(cursorPath, { offset: config.nextCursorOffset });
  }
  const incidents = config?.fix ? all : fresh;
  state.incidents = incidents;
  state.triage = incidents.map((incident) => {
    const issue = existing[all.indexOf(incident)];
    return issue
      ? { incident, ticket: { issueNumber: issue.number, url: issue.url } }
      : { incident };
  });
  state.summary = {
    ...(state.summary ?? EMPTY_SUMMARY),
    incidents: all.length,
    newIncidents: fresh.length,
  };
  console.log(`[dedupe] incidents=${all.length} new=${fresh.length}`);
}

async function reproduce(
  state: TriageState,
  strategy?: ReproStrategy,
): Promise<void> {
  const triage: IncidentTriage[] = [];
  for (const item of state.triage ?? []) {
    const repro = await reproduceIncident({
      logPath: state.logPath,
      baseUrl: state.pipelineConfig?.baseUrl ?? "http://localhost:3000",
      incident: item.incident,
    }, strategy);
    triage.push({ ...item, repro });
  }
  const reproduced = triage.filter(
    (item) => item.incident.sampleEvents[0]?.level === "error" && item.repro?.reproduced,
  ).length;
  state.triage = triage;
  state.summary = { ...(state.summary ?? EMPTY_SUMMARY), reproduced };
  console.log(`[reproduce] reproduced=${reproduced}/${triage.length}`);
}

async function route(
  state: TriageState,
  policy: RoutingPolicy,
  agent: TriageAgent,
  recorder: TraceRecorder,
): Promise<CostSample[]> {
  const triage: IncidentTriage[] = [];
  const costs: CostSample[] = [];
  for (const item of state.triage ?? []) {
    const repro = item.repro ?? {
      reproduced: false,
      command: "",
      evidence: "Reproduction stage did not return a result.",
    };
    const policyDecision = policy.evaluate({ incident: item.incident, repro });
    const fingerprint = item.incident.fingerprint.hash;
    const correlationId = createCorrelationId(recorder.runId, fingerprint);
    const started = performance.now();
    const decision = await routeIncident({
      policy: {
        authorizedClasses: policy.authorizedClasses,
        evaluate: () => policyDecision,
      },
      resolver: agent,
      incident: item.incident,
      repro,
    });
    const calls = agent.takeAgentCalls?.() ?? [];
    if (policyDecision.kind === "unknown" && calls.length === 0) {
      recorder.recordAgentCall({
        stage: "triage",
        resolution: "triage",
        fingerprint,
        correlationId,
        attemptId: createAttemptId(correlationId, "triage", 1),
        durationMs: Math.max(0, performance.now() - started),
        outcome: "success",
        unavailableReason: "agent-did-not-report-usage",
      });
    }
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (!call) continue;
      if (call.cost !== undefined) costs.push(call.cost);
      recorder.recordAgentCall({
        stage: "triage",
        resolution: "triage",
        fingerprint,
        correlationId,
        attemptId: createAttemptId(correlationId, "triage", index + 1),
        durationMs: call.durationMs,
        outcome: call.outcome,
        ...(call.cost === undefined ? {} : { cost: call.cost }),
        ...(call.fallback === undefined ? {} : { fallback: call.fallback }),
      });
    }
    triage.push({
      ...item,
      route: {
        ...decision,
        regressionTest: heuristicRegressionTestSpec(
          decision,
          item.incident,
          repro,
          state.pipelineConfig?.testScope[0] ?? "test",
        ),
      },
    });
  }
  const mechanical = triage.filter((item) => item.route?.kind === "mechanical").length;
  state.triage = triage;
  console.log(`[route] mechanical=${mechanical} needs-human=${triage.length - mechanical}`);
  return costs;
}

async function ticket(
  state: TriageState,
  github: GitHubOperations,
  config: PipelineConfig,
): Promise<void> {
  const triage: IncidentTriage[] = [];
  let issuesFiled = 0;
  let ticketFailed = false;
  for (const item of state.triage ?? []) {
    if (item.ticket) {
      triage.push(item);
      continue;
    }
    try {
      const issue = await github.createIssue(buildIssueInput(item, config.labels));
      triage.push({ ...item, ticket: { issueNumber: issue.number, url: issue.url } });
      issuesFiled += 1;
    } catch (error: unknown) {
      ticketFailed = true;
      state.errors.push(
        `ticket ${item.incident.fingerprint.hash}: ${error instanceof Error ? error.message : String(error)}`,
      );
      triage.push(item);
    }
  }
  if (!ticketFailed && state.config) {
    await writeCursor(config.cursorPath, { offset: Bun.file(state.logPath).size });
  }
  state.triage = triage;
  state.summary = { ...(state.summary ?? EMPTY_SUMMARY), issuesFiled };
  console.log(`[ticket] issues=${issuesFiled}`);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StageTraceSummary {
  outcome: string;
  detail?: Record<string, unknown>;
  cost?: CostSample;
}

async function runTracedStage<T>(
  recorder: TraceRecorder,
  stage: string,
  action: () => Promise<T>,
  summarize: (result: T) => StageTraceSummary,
  fingerprint?: string,
): Promise<T> {
  const event = recorder.start(stage, fingerprint);
  try {
    const result = await action();
    const summary = summarize(result);
    event.finish(summary.outcome, summary.detail, summary.cost);
    return result;
  } catch (error: unknown) {
    event.finish("error", { error: errorDetail(error) });
    throw error;
  }
}

async function removeWorktree(
  state: TriageState,
  worktrees: WorktreeOperations,
  worktreeDir: string,
): Promise<void> {
  try {
    await worktrees.remove(worktreeDir);
  } catch (error: unknown) {
    state.errors.push(`remove worktree ${worktreeDir}: ${errorDetail(error)}`);
  }
}

async function giveUp(
  state: TriageState,
  github: GitHubOperations,
  worktrees: WorktreeOperations,
  item: IncidentTriage,
  worktreeDir: string,
  attempts: number,
  detail: string,
  config: PipelineConfig,
): Promise<void> {
  const number = item.ticket?.issueNumber;
  if (number === undefined) throw new Error("give-up requires an issue ticket");
  try {
    try {
      await github.commentIssue(
        number,
        `Automated fix gave up after ${attempts} attempts.\n\n${detail}`,
      );
    } catch (error: unknown) {
      state.errors.push(`give-up comment issue ${number}: ${errorDetail(error)}`);
    }
    try {
      await github.replaceIssueLabel(
        number,
        config.labels.mechanical,
        config.labels.needsHuman,
      );
    } catch (error: unknown) {
      state.errors.push(`give-up label issue ${number}: ${errorDetail(error)}`);
    }
    console.log(`[give-up] issue=${number} attempts=${attempts}`);
  } finally {
    await removeWorktree(state, worktrees, worktreeDir);
  }
}

function pullRequestBody(
  item: IncidentTriage,
  fix: FixAttempt,
  verify: NonNullable<TriageState["activeVerify"]>,
  number: number,
  worktreeRoot: string,
  regressionTest: TriageState["activeRegressionTest"],
): string {
  return [
    "## What changed",
    "",
    rewritePathsForPrBody(fix.description, worktreeRoot),
    "",
    `Files: ${formatPrFilesList([
      ...fix.filesChanged,
      ...(regressionTest?.filesChanged ?? []),
    ], worktreeRoot)}`,
    "",
    formatRegressionTestIntent(regressionTest),
    "",
    "## Verification",
    "",
    "### Reproduction before",
    "",
    item.repro?.evidence ?? "No pre-fix evidence recorded.",
    "",
    "### Reproduction after",
    "",
    verify.reproEvidence ?? verify.detail,
    "",
    `- Regression test: ${verify.regressionTestDetail ?? (verify.regressionTestPasses ? "pass" : "fail")}`,
    `- Tests: ${verify.testSummary ?? (verify.testsPass ? "pass" : "fail")}`,
    `- Typecheck: ${verify.typecheckDetail ?? (verify.typecheckPasses ? "pass" : "fail")}`,
    "",
    `Fixes #${number}`,
  ].join("\n");
}

async function openPullRequest(
  state: TriageState,
  github: GitHubOperations,
  worktrees: WorktreeOperations,
  item: IncidentTriage,
  worktreeDir: string,
  fix: FixAttempt,
  verify: NonNullable<TriageState["activeVerify"]>,
  config: PipelineConfig,
): Promise<void> {
  const number = item.ticket?.issueNumber;
  if (number === undefined) throw new Error("pr requires an issue ticket");
  const short = `${item.incident.fingerprint.errName} on ${item.incident.fingerprint.route}`;
  const message = `fix: ${short} (${config.labels.pipeline} pipeline)\n\nFixes #${number}`;
  let pullRequest: PRRef | undefined;
  try {
    await worktrees.commit({ worktreeDir, message });
    await worktrees.push({ worktreeDir, branch: fix.branch });
    pullRequest = await github.createPullRequest({
      title: `[${config.labels.pipeline}] fix: ${short}`,
      body: pullRequestBody(
        item,
        fix,
        verify,
        number,
        config.worktreeRoot,
        state.activeRegressionTest,
      ),
      head: fix.branch,
      base: "main",
      labels: [config.labels.pipeline],
    });
    await github.commentIssue(number, `Fix verified and PR opened: ${pullRequest.url}`);
    state.pullRequests = [...state.pullRequests ?? [], pullRequest];
    console.log(`[pr] issue=${number} url=${pullRequest.url}`);
  } catch (error: unknown) {
    state.errors.push(`pr issue ${number}: ${errorDetail(error)}`);
  } finally {
    await removeWorktree(state, worktrees, worktreeDir);
  }
}

export async function runAgentSdkPipeline(
  config: PipelineConfig,
  options: AgentSdkPipelineOptions,
  dependencies: PipelineDependencies = {},
): Promise<AgentSdkPipelineResult> {
  const repoRoot = dependencies.repoRoot ?? resolve(import.meta.dir, "../../..");
  const resolvedRuntime = resolvePipelineRuntime({
    pipeline: "agent-sdk",
    config,
    mode: options,
    overrides: {
      triage: dependencies.triageAgent !== undefined,
      testWriter: dependencies.testWriter !== undefined || dependencies.createTestWriter !== undefined,
      fixer: dependencies.fixer !== undefined || dependencies.createFixer !== undefined,
    },
  });
  const baseWorkload = await resolveTraceWorkload(config, repoRoot);
  const workload = {
    ...baseWorkload,
    ...(options.watchSessionId === undefined
      ? {}
      : { watchSessionId: options.watchSessionId }),
    ...(options.watchPass === undefined ? {} : { watchPass: options.watchPass }),
  };
  const github = dependencies.github ?? new GitHubClient(config.repo);
  const recorder = dependencies.recorder ?? new TraceRecorder({
    pipeline: "agent-sdk",
    resolved: resolvedRuntime,
    workload,
    traceRoot: resolve(repoRoot, "traces"),
    ...(options.tracePath === undefined ? {} : { outputPath: options.tracePath }),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  const state = initialState(config, options);

  try {
    await runTracedStage(recorder, "ingest", () => ingest(state), () => ({
      outcome: `${state.summary?.eventsRead ?? 0} events`,
      detail: { events: state.summary?.eventsRead ?? 0 },
    }));

    await runTracedStage(
      recorder,
      "detect",
      async () => detect(state, config, dependencies.reproStrategy),
      () => ({
        outcome: `${state.summary?.actionable ?? 0} actionable`,
        detail: { actionable: state.summary?.actionable ?? 0 },
      }),
    );

    await runTracedStage(recorder, "dedupe", () => dedupe(state, github), () => ({
      outcome: `${state.summary?.newIncidents ?? 0} new incidents`,
      detail: {
        incidents: state.summary?.incidents ?? 0,
        newIncidents: state.summary?.newIncidents ?? 0,
      },
    }));
    if (state.incidents.length === 0) {
      return { state, summary: state.summary ?? EMPTY_SUMMARY };
    }

    await runTracedStage(
      recorder,
      "reproduce",
      () => reproduce(state, dependencies.reproStrategy),
      () => ({
        outcome: `${state.summary?.reproduced ?? 0} reproduced`,
        detail: { reproduced: state.summary?.reproduced ?? 0 },
      }),
    );

    const policy: RoutingPolicy = dependencies.routingPolicy ?? {
      authorizedClasses: [],
      evaluate: () => ({
        kind: "unknown",
        reason: "No consumer routing policy was supplied.",
      }),
    };
    const agent = dependencies.triageAgent ?? new ClaudeTriageAgent(
      repoRoot,
      config.fixScope,
      undefined,
      undefined,
      resolvedRuntime.triage.requestedModel ?? "sonnet",
    );
    await runTracedStage(
      recorder,
      "route",
      () => route(state, policy, agent, recorder),
      (routeCosts) => {
        const mechanicalCount = (state.triage ?? []).filter(
          (item) => item.route?.kind === "mechanical",
        ).length;
        return {
          outcome: `${mechanicalCount} mechanical`,
          detail: {
            mechanical: mechanicalCount,
            needsHuman: (state.triage?.length ?? 0) - mechanicalCount,
          },
          cost: combineCostSamples(routeCosts),
        };
      },
    );

    await runTracedStage(recorder, "ticket", () => ticket(state, github, config), () => ({
      outcome: `${state.summary?.issuesFiled ?? 0} issues`,
      detail: { issuesFiled: state.summary?.issuesFiled ?? 0 },
    }));

    if (state.config?.fix) {
      const worktrees = dependencies.worktrees ?? new GitWorktreeOperations(
        repoRoot,
        config.worktreeRoot,
        config.fixScope,
        config.testScope,
      );
      const mechanical = (state.triage ?? []).filter(
        (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
      );
      if (
        mechanical.length > 1 &&
        (dependencies.fixer !== undefined || dependencies.testWriter !== undefined)
      ) {
        throw new Error(
          "multiple incident workers require createFixer/createTestWriter factories instead of shared instances",
        );
      }
      const createFixer = dependencies.createFixer ?? (() =>
        dependencies.fixer ?? createResolvedFixer(config.fixScope, resolvedRuntime.fixer));
      const createVerifier = dependencies.createVerifier ?? (() =>
        dependencies.verifier ?? new RealVerifyRunner(config, dependencies.reproStrategy));
      const createTestWriter = dependencies.createTestWriter ??
        (dependencies.testWriter === undefined ? undefined : () => dependencies.testWriter!);
      const completed: Array<IncidentResult | Error> = await runIncidentWorkers({
        items: mechanical,
        config,
        recorder,
        worktrees,
        createFixer,
        ...(createTestWriter === undefined ? {} : { createTestWriter }),
        testWriterResolution: resolvedRuntime.testWriter,
        createVerifier,
        readIssue: (number) => github.readIssue(number),
        regressionTestStrategy: dependencies.regressionTestStrategy,
      });
      for (let index = 0; index < completed.length; index += 1) {
        const result = completed[index];
        const item = mechanical[index];
        if (!item || !result) continue;
        if (result instanceof Error) {
          state.errors.push(`fix ${item.incident.fingerprint.hash}: ${result.message}`);
          continue;
        }
        state.fixAttempts = [...state.fixAttempts ?? [], ...result.fixAttempts];
        state.regressionTestAttempts = [
          ...state.regressionTestAttempts ?? [],
          ...result.regressionTest.attempts,
        ];
        state.verifyResults = [...state.verifyResults ?? [], ...result.verifyResults];
        state.activeRegressionTest = result.regressionTest;
        const stage = result.outcome === "verified" ? "pr" : "give-up";
        const lifecycleEvent = recorder.start(
          stage,
          result.item.incident.fingerprint.hash,
          {
            correlationId: result.correlationId,
            attemptId: createAttemptId(result.correlationId, stage, 1),
          },
        );
        const errorCount = state.errors.length;
        try {
          if (result.outcome === "verified") {
            await openPullRequest(
              state,
              github,
              worktrees,
              result.item,
              result.worktreeDir,
              result.finalFix,
              result.finalVerify,
              config,
            );
          } else {
            await giveUp(
              state,
              github,
              worktrees,
              result.item,
              result.worktreeDir,
              result.fixAttempts.length,
              result.finalVerify.detail,
              config,
            );
          }
        } catch (error: unknown) {
          state.errors.push(`fix ${item.incident.fingerprint.hash}: ${errorDetail(error)}`);
        } finally {
          lifecycleEvent.finish(
            state.errors.length > errorCount
              ? "error"
              : result.outcome === "verified"
                ? "completed"
                : "needs human",
            { issueNumber: result.item.ticket?.issueNumber },
          );
        }
      }
    }

    return { state, summary: state.summary ?? EMPTY_SUMMARY };
  } finally {
    await recorder.finish();
  }
}

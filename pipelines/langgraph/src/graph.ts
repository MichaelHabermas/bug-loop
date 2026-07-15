import { resolve } from "node:path";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  GitHubClient,
  GitWorktreeOperations,
  RealVerifyRunner,
  createResolvedFixer,
  mapWithConcurrency,
  PristineSuiteCache,
  runIncidentWorker,
  takeFixerCost,
  verifyWithRunner,
  resolvePipelineRuntime,
  type FixAttempt,
  type Fixer,
  type TestWriter,
  type Incident,
  type IncidentTriage,
  type IncidentResult,
  type IssueInput,
  type IssueDetails,
  type IssueRef,
  type LogEvent,
  type OpenIssue,
  type PipelineConfig,
  type PRInput,
  type PRRef,
  type PullRequestRef,
  type RegressionTestAttempt,
  type RegressionTestRecord,
  type ReproResult,
  type ReproStrategy,
  type RegressionTestStrategy,
  type RoutingPolicy,
  type ResolvedPipeline,
  type TicketRef,
  type TraceRecorder,
  type TriageRunConfig,
  type TriageState,
  type TriageSummary,
  type VerifyResult,
  type VerifyRunner,
  type WorktreeOperations,
} from "@bug-loop/core";
import {
  dedupeNode,
  detectNode,
  fixWithDependencies,
  giveUpWithDependencies,
  ingestNode,
  prWithDependencies,
  reproduceNode,
  routeNode,
  ticketNode,
  testgenWithDependencies,
  type GitHubOperations,
} from "./nodes";

const TriageAnnotation = Annotation.Root({
  logPath: Annotation<string>,
  pipelineConfig: Annotation<PipelineConfig | undefined>,
  events: Annotation<LogEvent[]>,
  actionableEvents: Annotation<LogEvent[]>,
  incidents: Annotation<Incident[]>,
  triage: Annotation<IncidentTriage[]>,
  config: Annotation<TriageRunConfig | undefined>,
  summary: Annotation<TriageSummary | undefined>,
  activeIncident: Annotation<Incident | null | undefined>,
  fixQueue: Annotation<Incident[] | undefined>,
  worktreeDir: Annotation<string | null | undefined>,
  worktreeBaseCommit: Annotation<string | undefined>,
  pipelineHeadCommit: Annotation<string | undefined>,
  activeRepro: Annotation<ReproResult | undefined>,
  activeTicket: Annotation<TicketRef | undefined>,
  activeIssue: Annotation<IssueDetails | null | undefined>,
  activeFix: Annotation<FixAttempt | undefined>,
  activeRegressionTest: Annotation<RegressionTestRecord | undefined>,
  activeVerify: Annotation<VerifyResult | undefined>,
  fixAttempts: Annotation<FixAttempt[] | undefined>,
  regressionTestAttempts: Annotation<RegressionTestAttempt[] | undefined>,
  verifyResults: Annotation<VerifyResult[] | undefined>,
  pullRequests: Annotation<PullRequestRef[] | undefined>,
  retryCount: Annotation<number>,
  errors: Annotation<string[]>,
});

export interface InitialStateOptions extends TriageRunConfig {}

export function createInitialState(
  config: PipelineConfig,
  options: InitialStateOptions,
): TriageState {
  return {
    logPath: config.logPath,
    pipelineConfig: config,
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
    },
    retryCount: 0,
    errors: [],
  };
}

interface PipelineGitHubOperations extends GitHubOperations {
  listOpenIssues(): Promise<OpenIssue[]>;
  createIssue(input: IssueInput): Promise<IssueRef>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export interface GraphOptions {
  routingPolicy?: RoutingPolicy;
  regressionTestStrategy?: RegressionTestStrategy;
  fixer?: Fixer;
  createFixer?: () => Fixer;
  testWriter?: TestWriter;
  createTestWriter?: () => TestWriter;
  verifier?: VerifyRunner;
  createVerifier?: () => VerifyRunner;
  worktrees?: WorktreeOperations;
  github?: PipelineGitHubOperations;
  reproStrategy?: ReproStrategy;
  recorder?: TraceRecorder;
  resolved?: ResolvedPipeline;
  repoRoot?: string;
}

export function routeAfterTicket(
  state: TriageState,
  triage = state.triage ?? [],
): "testgen" | "end" {
  const hasMechanical = triage.some(
    (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
  );
  return state.config?.fix && hasMechanical ? "testgen" : "end";
}

export function routeAfterVerify(state: TriageState): "pr" | "fix" | "give-up" {
  if (state.activeVerify?.verified) return "pr";
  const maxAttempts = state.pipelineConfig?.maxFixAttempts ?? 1;
  return state.retryCount >= maxAttempts ? "give-up" : "fix";
}

export function routeAfterIncident(state: TriageState): "testgen" | "end" {
  return state.activeIncident ? "testgen" : "end";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tracedNode(
  recorder: TraceRecorder | undefined,
  stage: string,
  run: () => Promise<Partial<TriageState>>,
  summarize: (result: Partial<TriageState>) => {
    outcome: string;
    detail?: Record<string, unknown>;
  },
  fingerprint?: string,
): Promise<Partial<TriageState>> {
  const event = recorder?.start(stage, fingerprint);
  try {
    const result = await run();
    const summary = summarize(result);
    event?.finish(summary.outcome, summary.detail);
    return result;
  } catch (error: unknown) {
    event?.finish("error", { error: errorDetail(error) });
    throw error;
  }
}

export function createTriageGraph(config: PipelineConfig, options: GraphOptions = {}) {
  const checkpointer = new MemorySaver();
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "../../..");
  const resolvedRuntime = options.resolved ?? resolvePipelineRuntime({
    pipeline: "langgraph",
    config,
    mode: { fromStart: false, fix: false, live: false },
    overrides: {
      triage: false,
      testWriter: options.testWriter !== undefined,
      fixer: options.fixer !== undefined,
    },
  });
  const github = options.github ?? new GitHubClient(config.repo);
  const routingPolicy: RoutingPolicy = options.routingPolicy ?? {
    authorizedClasses: [],
    evaluate: () => ({
      kind: "unknown",
      reason: "No consumer routing policy was supplied.",
    }),
  };
  const reproStrategy = options.reproStrategy;
  const worktrees = options.worktrees ?? new GitWorktreeOperations(
    repoRoot,
    config.worktreeRoot,
    config.fixScope,
    config.testScope,
  );
  const verifier = options.verifier ?? new RealVerifyRunner(config, reproStrategy);
  let fixer = options.fixer;
  const testgen = (state: TriageState) => testgenWithDependencies(state, {
    config,
    writer: options.testWriter,
    verifier,
    worktrees,
    recorder: options.recorder,
    repoRoot,
    testWriterResolution: resolvedRuntime.testWriter,
    regressionTestStrategy: options.regressionTestStrategy,
  });

  const ingest = (state: TriageState) => tracedNode(
    options.recorder,
    "ingest",
    () => ingestNode(state),
    (result) => ({
      outcome: `${result.summary?.eventsRead ?? 0} events`,
      detail: { events: result.summary?.eventsRead ?? 0 },
    }),
  );
  const detect = (state: TriageState) => tracedNode(
    options.recorder,
    "detect",
    async () => {
      return detectNode(state, config.invariantWarnPrefixes, reproStrategy);
    },
    (result) => ({
      outcome: `${result.summary?.actionable ?? 0} actionable`,
      detail: { actionable: result.summary?.actionable ?? 0 },
    }),
  );
  const dedupe = (state: TriageState) => tracedNode(
    options.recorder,
    "dedupe",
    async () => dedupeNode(state, await github.listOpenIssues()),
    (result) => ({
      outcome: `${result.summary?.newIncidents ?? 0} new incidents`,
      detail: {
        incidents: result.summary?.incidents ?? 0,
        newIncidents: result.summary?.newIncidents ?? 0,
      },
    }),
  );
  const reproduce = (state: TriageState) => tracedNode(
    options.recorder,
    "reproduce",
    () => reproduceNode(state, reproStrategy),
    (result) => ({
      outcome: `${result.summary?.reproduced ?? 0} reproduced`,
      detail: { reproduced: result.summary?.reproduced ?? 0 },
    }),
  );
  const route = (state: TriageState) => tracedNode(
    options.recorder,
    "route",
    () => routeNode(state, routingPolicy),
    (result) => {
      const triage = result.triage ?? [];
      const mechanical = triage.filter((item) => item.route?.kind === "mechanical").length;
      return {
        outcome: `${mechanical} mechanical`,
        detail: { mechanical, needsHuman: triage.length - mechanical },
      };
    },
  );
  const ticket = (state: TriageState) => tracedNode(
    options.recorder,
    "ticket",
    () => ticketNode(state, (input) => github.createIssue(input), config.labels),
    (result) => ({
      outcome: `${result.summary?.issuesFiled ?? 0} issues`,
      detail: { issuesFiled: result.summary?.issuesFiled ?? 0 },
    }),
  );
  const fix = async (state: TriageState): Promise<Partial<TriageState>> => {
    fixer ??= createResolvedFixer(config.fixScope, resolvedRuntime.fixer);
    const fingerprint = state.activeIncident?.fingerprint.hash;
    const event = options.recorder?.start("fix", fingerprint);
    try {
      const result = await fixWithDependencies(state, {
        config,
        fixer,
        worktrees,
        readIssue: (number) => github.readIssue(number),
        repoRoot,
      });
      const activeFix = result.activeFix;
      const fixerFailed = activeFix?.description.startsWith("Fixer failed:") ?? false;
      event?.finish(
        fixerFailed ? "error" : activeFix ? `attempt ${activeFix.attempt}` : "no fix",
        activeFix
          ? {
              attempt: activeFix.attempt,
              filesChanged: activeFix.filesChanged,
              ...(fixerFailed ? { error: activeFix.description } : {}),
            }
          : undefined,
        takeFixerCost(fixer),
      );
      return result;
    } catch (error: unknown) {
      event?.finish("error", { error: errorDetail(error) }, takeFixerCost(fixer));
      throw error;
    }
  };
  const verify = async (state: TriageState): Promise<Partial<TriageState>> => {
    const fingerprint = state.activeIncident?.fingerprint.hash;
    const event = options.recorder?.start("verify", fingerprint);
    try {
      const result = await verifyWithRunner(state, verifier, config.fixScope, worktrees);
      event?.finish(
        result.activeVerify?.verified ? "verified" : "failed",
        {
          attempt: state.activeFix?.attempt,
          scopePasses: result.activeVerify?.scopePasses,
          reproPasses: result.activeVerify?.reproPasses,
          testsPass: result.activeVerify?.testsPass,
          regressionTestPasses: result.activeVerify?.regressionTestPasses,
          typecheckPasses: result.activeVerify?.typecheckPasses,
        },
      );
      return result;
    } catch (error: unknown) {
      event?.finish("error", { error: errorDetail(error) });
      throw error;
    }
  };
  const giveUp = (state: TriageState) => tracedNode(
    options.recorder,
    "give-up",
    () => giveUpWithDependencies(state, { config, github, worktrees, repoRoot }),
    (result) => ({
      outcome: (result.errors?.length ?? 0) > state.errors.length ? "error" : "needs human",
      detail: { attempts: state.retryCount },
    }),
    state.activeIncident?.fingerprint.hash,
  );
  const pr = (state: TriageState) => tracedNode(
    options.recorder,
    "pr",
    () => prWithDependencies(state, { config, github, worktrees, repoRoot }),
    (result) => ({
      outcome: (result.errors?.length ?? 0) > state.errors.length ? "error" : "completed",
    }),
    state.activeIncident?.fingerprint.hash,
  );
  const workers = async (state: TriageState): Promise<Partial<TriageState>> => {
    if (
      config.incidentConcurrency > 1 &&
      (options.fixer !== undefined || options.testWriter !== undefined)
    ) {
      throw new Error(
        "incidentConcurrency > 1 requires createFixer/createTestWriter factories instead of shared instances",
      );
    }
    const mechanical = (state.triage ?? []).filter(
      (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
    );
    const pristineSuiteCache = new PristineSuiteCache();
    const createFixer = options.createFixer ?? (() =>
      options.fixer ?? createResolvedFixer(config.fixScope, resolvedRuntime.fixer));
    const createVerifier = options.createVerifier ?? (() =>
      options.verifier ?? new RealVerifyRunner(config, reproStrategy));
    const createTestWriter = options.createTestWriter ??
      (options.testWriter === undefined ? undefined : () => options.testWriter!);
    const completed: Array<IncidentResult | Error> = await mapWithConcurrency(
      mechanical,
      config.incidentConcurrency,
      async (item) => {
        try {
          return await runIncidentWorker({
            item,
            config,
            recorder: options.recorder,
            worktrees,
            createFixer,
            ...(createTestWriter === undefined ? {} : { createTestWriter }),
            testWriterResolution: resolvedRuntime.testWriter,
            createVerifier,
            readIssue: (number) => github.readIssue(number),
            regressionTestStrategy: options.regressionTestStrategy,
            pristineSuiteCache,
          });
        } catch (error: unknown) {
          return error instanceof Error ? error : new Error(String(error));
        }
      },
    );
    let errors = [...state.errors];
    let pullRequests = [...(state.pullRequests ?? [])];
    const fixAttempts = [...(state.fixAttempts ?? [])];
    const regressionTestAttempts = [...(state.regressionTestAttempts ?? [])];
    const verifyResults = [...(state.verifyResults ?? [])];
    for (let index = 0; index < completed.length; index += 1) {
      const result = completed[index];
      const item = mechanical[index];
      if (!item || !result) continue;
      if (result instanceof Error) {
        errors.push(`fix ${item.incident.fingerprint.hash}: ${result.message}`);
        continue;
      }
      fixAttempts.push(...result.fixAttempts);
      regressionTestAttempts.push(...result.regressionTest.attempts);
      verifyResults.push(...result.verifyResults);
      const lifecycleState: TriageState = {
        ...state,
        activeIncident: result.item.incident,
        worktreeDir: result.worktreeDir,
        activeTicket: result.item.ticket,
        activeRepro: result.item.repro,
        activeFix: result.finalFix,
        activeRegressionTest: result.regressionTest,
        activeVerify: result.finalVerify,
        retryCount: result.fixAttempts.length,
        errors,
        pullRequests,
      };
      const stage = result.outcome === "verified" ? "pr" : "give-up";
      const event = options.recorder?.start(
        stage,
        result.item.incident.fingerprint.hash,
        { correlationId: result.correlationId },
      );
      const lifecycle = result.outcome === "verified"
        ? await prWithDependencies(lifecycleState, { config, github, worktrees, repoRoot })
        : await giveUpWithDependencies(lifecycleState, { config, github, worktrees, repoRoot });
      errors = lifecycle.errors ?? errors;
      pullRequests = lifecycle.pullRequests ?? pullRequests;
      event?.finish(
        errors.length > lifecycleState.errors.length
          ? "error"
          : result.outcome === "verified"
            ? "completed"
            : "needs human",
        { issueNumber: result.item.ticket?.issueNumber },
      );
    }
    return {
      fixAttempts,
      regressionTestAttempts,
      verifyResults,
      pullRequests,
      errors,
      activeIncident: null,
      worktreeDir: null,
      retryCount: 0,
    };
  };

  return new StateGraph(TriageAnnotation)
    .addNode("ingest", ingest)
    .addNode("detect", detect)
    .addNode("dedupe", dedupe)
    .addNode("reproduce", reproduce)
    .addNode("route", route)
    .addNode("ticket", ticket)
    .addNode("testgen", testgen)
    .addNode("fix", fix)
    .addNode("verify", verify)
    .addNode("give-up", giveUp)
    .addNode("pr", pr)
    .addNode("workers", workers)
    .addEdge(START, "ingest")
    .addEdge("ingest", "detect")
    .addEdge("detect", "dedupe")
    .addConditionalEdges(
      "dedupe",
      (state) => (state.incidents.length === 0 ? END : "reproduce"),
      [END, "reproduce"],
    )
    .addEdge("reproduce", "route")
    .addEdge("route", "ticket")
    .addConditionalEdges(
      "ticket",
      (state) => (routeAfterTicket(state) === "testgen" ? "workers" : END),
      ["workers", END],
    )
    .addEdge("workers", END)
    .addEdge("testgen", "fix")
    .addEdge("fix", "verify")
    .addConditionalEdges("verify", routeAfterVerify, ["pr", "fix", "give-up"])
    .addConditionalEdges(
      "pr",
      (state) => (routeAfterIncident(state) === "testgen" ? "testgen" : END),
      ["testgen", END],
    )
    .addConditionalEdges(
      "give-up",
      (state) => (routeAfterIncident(state) === "testgen" ? "testgen" : END),
      ["testgen", END],
    )
    .compile({ checkpointer });
}

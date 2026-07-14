import { resolve } from "node:path";
import {
  buildIssueInput,
  combineCostSamples,
  createDefaultFixer,
  formatPrFilesList,
  GitHubClient,
  GitWorktreeOperations,
  groupIncidents,
  isHeuristicallyActionable,
  readCursor,
  readNewEvents,
  RealVerifyRunner,
  reproduceIncident,
  rewritePathsForPrBody,
  takeFixerCost,
  TraceRecorder,
  verifyWithRunner,
  writeCursor,
  type FixAttempt,
  type Fixer,
  type CostSample,
  type IncidentTriage,
  type IssueDetails,
  type IssueInput,
  type IssueRef,
  type PRInput,
  type PRRef,
  type PipelineConfig,
  type ReproStrategy,
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
}

export interface GitHubOperations {
  findOpenIssueByMarker(hash: string): Promise<IssueRef | null>;
  createIssue(input: IssueInput): Promise<IssueRef>;
  readIssue(number: number): Promise<IssueDetails | null>;
  commentIssue(number: number, body: string): Promise<void>;
  replaceIssueLabel(number: number, remove: string, add: string): Promise<void>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export interface PipelineDependencies {
  triageAgent?: TriageAgent;
  fixer?: Fixer;
  verifier?: VerifyRunner;
  worktrees?: WorktreeOperations;
  github?: GitHubOperations;
  reproStrategy?: ReproStrategy;
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
    verifyResults: [],
    pullRequests: [],
    config: {
      fromStart: options.fromStart,
      fix: options.fix ?? false,
      live: options.live ?? false,
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
    .filter((event) => isHeuristicallyActionable(event, config.invariantWarnPrefixes))
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
  const existing = await Promise.all(
    all.map((incident) => github.findOpenIssueByMarker(incident.fingerprint.hash)),
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

function takeTriageCost(agent: TriageAgent): CostSample | undefined {
  const candidate = agent as TriageAgent & { takeCost?: () => CostSample | undefined };
  return candidate.takeCost?.();
}

async function route(state: TriageState, agent: TriageAgent): Promise<CostSample[]> {
  const triage: IncidentTriage[] = [];
  const costs: CostSample[] = [];
  for (const item of state.triage ?? []) {
    const repro = item.repro ?? {
      reproduced: false,
      command: "",
      evidence: "Reproduction stage did not return a result.",
    };
    const decision = await agent.triage({ incident: item.incident, repro });
    const cost = takeTriageCost(agent);
    if (cost) costs.push(cost);
    triage.push({
      ...item,
      route: {
        kind: decision.decision,
        reason: decision.reason,
        fixBrief: decision.fixBrief,
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

function activeState(
  state: TriageState,
  item: IncidentTriage,
  worktreeDir: string,
  activeFix: FixAttempt,
  retryCount: number,
): TriageState {
  return {
    ...state,
    activeIncident: item.incident,
    worktreeDir,
    activeTicket: item.ticket,
    activeRepro: item.repro,
    activeFix,
    retryCount,
  };
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
): string {
  return [
    "## What changed",
    "",
    rewritePathsForPrBody(fix.description, worktreeRoot),
    "",
    `Files: ${formatPrFilesList(fix.filesChanged, worktreeRoot)}`,
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
      body: pullRequestBody(item, fix, verify, number, config.worktreeRoot),
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

async function fixIncident(
  state: TriageState,
  item: IncidentTriage,
  fixer: Fixer,
  verifier: VerifyRunner,
  worktrees: WorktreeOperations,
  github: GitHubOperations,
  config: PipelineConfig,
  recorder: TraceRecorder,
): Promise<void> {
  const fingerprint8 = item.incident.fingerprint.hash.slice(0, 8);
  const branch = `${config.branchPrefix}${fingerprint8}`;
  const created = await worktrees.create({ branch, fingerprint8 });
  const generatedIssue = buildIssueInput(item, config.labels);
  let previousFailure: string | undefined;

  for (let attempt = 1; attempt <= config.maxFixAttempts; attempt += 1) {
    let issue: IssueDetails | null = null;
    try {
      issue = await github.readIssue(item.ticket?.issueNumber ?? 0);
    } catch (error: unknown) {
      console.warn(`[fix] issue read failed; using generated issue body: ${errorDetail(error)}`);
    }

    let fix: FixAttempt;
    const fixEvent = recorder.start("fix", item.incident.fingerprint.hash);
    try {
      const output = await fixer.fix({
        worktreeDir: created.worktreeDir,
        issueTitle: issue?.title ?? generatedIssue.title,
        issueBody: issue?.body ?? generatedIssue.body,
        attempt,
        fixBrief: item.route?.fixBrief ?? "",
        ...(previousFailure === undefined ? {} : { previousFailure }),
      });
      fix = { attempt, branch, ...output };
      fixEvent.finish(
        `attempt ${attempt}`,
        { attempt, filesChanged: output.filesChanged },
        takeFixerCost(fixer),
      );
    } catch (error: unknown) {
      fix = {
        attempt,
        branch,
        description: `Fixer failed: ${errorDetail(error)}`,
        filesChanged: [],
      };
      fixEvent.finish(
        "error",
        { attempt, error: errorDetail(error) },
        takeFixerCost(fixer),
      );
    }
    state.fixAttempts = [...state.fixAttempts ?? [], fix];
    console.log(`[fix] fingerprint=${fingerprint8} attempt=${attempt} files=${fix.filesChanged.length}`);

    const verifyState = activeState(state, item, created.worktreeDir, fix, attempt - 1);
    const verified = await runTracedStage(
      recorder,
      "verify",
      () => verifyWithRunner(verifyState, verifier, config.fixScope),
      (verifyResult) => {
        const result = verifyResult.activeVerify;
        if (!result) throw new Error("verify did not return a result");
        return {
          outcome: result.verified ? "verified" : "failed",
          detail: {
            attempt,
            scopePasses: result.scopePasses,
            reproPasses: result.reproPasses,
            testsPass: result.testsPass,
            typecheckPasses: result.typecheckPasses,
          },
        };
      },
      item.incident.fingerprint.hash,
    );
    const result = verified.activeVerify;
    if (!result) throw new Error("verify did not return a result");
    state.verifyResults = verified.verifyResults ?? state.verifyResults;
    console.log(`[verify] fingerprint=${fingerprint8} attempt=${attempt} verified=${result.verified}`);
    if (result.verified) {
      const errorsBefore = state.errors.length;
      await runTracedStage(
        recorder,
        "pr",
        () => openPullRequest(
          state,
          github,
          worktrees,
          item,
          created.worktreeDir,
          fix,
          result,
          config,
        ),
        () => ({
          outcome: state.errors.length === errorsBefore ? "completed" : "error",
          detail: { issueNumber: item.ticket?.issueNumber },
        }),
        item.incident.fingerprint.hash,
      );
      return;
    }
    previousFailure = result.detail;
  }

  const errorsBefore = state.errors.length;
  await runTracedStage(
    recorder,
    "give-up",
    () => giveUp(
      state,
      github,
      worktrees,
      item,
      created.worktreeDir,
      config.maxFixAttempts,
      previousFailure ?? "Verification did not provide details.",
      config,
    ),
    () => ({
      outcome: state.errors.length === errorsBefore ? "needs human" : "error",
      detail: {
        attempts: config.maxFixAttempts,
        issueNumber: item.ticket?.issueNumber,
      },
    }),
    item.incident.fingerprint.hash,
  );
}

export async function runAgentSdkPipeline(
  config: PipelineConfig,
  options: AgentSdkPipelineOptions,
  dependencies: PipelineDependencies = {},
): Promise<AgentSdkPipelineResult> {
  const repoRoot = dependencies.repoRoot ?? resolve(import.meta.dir, "../../..");
  const github = dependencies.github ?? new GitHubClient(config.repo);
  const recorder = dependencies.recorder ?? new TraceRecorder({
    pipeline: "agent-sdk",
    config,
    traceRoot: resolve(repoRoot, "traces"),
    ...(options.tracePath === undefined ? {} : { outputPath: options.tracePath }),
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

    const agent = dependencies.triageAgent ?? new ClaudeTriageAgent(repoRoot, config.fixScope);
    await runTracedStage(
      recorder,
      "route",
      () => route(state, agent),
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
      const fixer = dependencies.fixer ?? createDefaultFixer(config.fixScope, config.fixer);
      const verifier = dependencies.verifier ?? new RealVerifyRunner(config, dependencies.reproStrategy);
      const worktrees = dependencies.worktrees ?? new GitWorktreeOperations(
        repoRoot,
        config.worktreeRoot,
        config.fixScope,
      );
      const mechanical = (state.triage ?? []).filter(
        (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
      );
      for (const item of mechanical) {
        try {
          await fixIncident(
            state,
            item,
            fixer,
            verifier,
            worktrees,
            github,
            config,
            recorder,
          );
        } catch (error: unknown) {
          state.errors.push(`fix ${item.incident.fingerprint.hash}: ${errorDetail(error)}`);
        }
      }
    }

    return { state, summary: state.summary ?? EMPTY_SUMMARY };
  } finally {
    await recorder.finish();
  }
}

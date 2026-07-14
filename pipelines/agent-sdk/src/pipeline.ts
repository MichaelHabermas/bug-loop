import { resolve } from "node:path";
import {
  buildIssueInput,
  commentIssue,
  createDefaultFixer,
  createIssue,
  createPullRequest,
  enrichActionableEvent,
  findOpenIssueByMarker,
  formatPrFilesList,
  GitWorktreeOperations,
  groupIncidents,
  isHeuristicallyActionable,
  readCursor,
  readIssue,
  readNewEvents,
  RealVerifyRunner,
  replaceIssueLabel,
  reproduceIncident,
  rewritePathsForPrBody,
  verifyWithRunner,
  writeCursor,
  type FixAttempt,
  type Fixer,
  type IncidentTriage,
  type IssueDetails,
  type IssueInput,
  type IssueRef,
  type PRInput,
  type PRRef,
  type ReproduceInput,
  type ReproResult,
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
  logPath: string;
}

export interface GitHubOperations {
  findOpenIssueByMarker(hash: string): Promise<IssueRef | null>;
  createIssue(input: IssueInput): Promise<IssueRef>;
  readIssue(number: number): Promise<IssueDetails | null>;
  commentIssue(number: number, body: string): Promise<void>;
  replaceIssueLabel(number: number, remove: string, add: string): Promise<void>;
  createPullRequest(input: PRInput): Promise<PRRef>;
}

export type Reproducer = (input: ReproduceInput) => Promise<ReproResult>;

export interface PipelineDependencies {
  triageAgent?: TriageAgent;
  fixer?: Fixer;
  verifier?: VerifyRunner;
  worktrees?: WorktreeOperations;
  github?: GitHubOperations;
  reproduce?: Reproducer;
  repoRoot?: string;
}

export interface AgentSdkPipelineResult {
  state: TriageState;
  summary: TriageSummary;
}

const defaultGitHub: GitHubOperations = {
  findOpenIssueByMarker,
  createIssue,
  readIssue,
  commentIssue,
  replaceIssueLabel,
  createPullRequest,
};

function initialState(options: AgentSdkPipelineOptions): TriageState {
  return {
    logPath: options.logPath,
    events: [],
    actionableEvents: [],
    incidents: [],
    triage: [],
    fixAttempts: [],
    verifyResults: [],
    pullRequests: [],
    config: {
      cursorPath: options.cursorPath,
      fromStart: options.fromStart,
      baseUrl: options.baseUrl,
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
  if (!config) throw new Error("ingest requires state.config");
  const cursor = config.fromStart ? { offset: 0 } : await readCursor(config.cursorPath);
  const result = await readNewEvents(state.logPath, cursor);
  state.events = result.events;
  state.config = { ...config, nextCursorOffset: result.cursor.offset };
  state.summary = { ...EMPTY_SUMMARY, eventsRead: result.events.length };
  console.log(`[ingest] events=${result.events.length}`);
}

function detect(state: TriageState): void {
  const actionable = state.events
    .filter(isHeuristicallyActionable)
    .map(enrichActionableEvent);
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
    await writeCursor(config.cursorPath, { offset: config.nextCursorOffset });
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
  runReproduction: Reproducer,
): Promise<void> {
  const triage: IncidentTriage[] = [];
  for (const item of state.triage ?? []) {
    const repro = await runReproduction({
      logPath: state.logPath,
      baseUrl: state.config?.baseUrl ?? "http://localhost:3000",
      incident: item.incident,
    });
    triage.push({ ...item, repro });
  }
  const reproduced = triage.filter(
    (item) => item.incident.sampleEvents[0]?.level === "error" && item.repro?.reproduced,
  ).length;
  state.triage = triage;
  state.summary = { ...(state.summary ?? EMPTY_SUMMARY), reproduced };
  console.log(`[reproduce] reproduced=${reproduced}/${triage.length}`);
}

async function route(state: TriageState, agent: TriageAgent): Promise<void> {
  const triage: IncidentTriage[] = [];
  for (const item of state.triage ?? []) {
    const repro = item.repro ?? {
      reproduced: false,
      command: "",
      evidence: "Reproduction stage did not return a result.",
    };
    const decision = await agent.triage({ incident: item.incident, repro });
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
}

async function ticket(state: TriageState, github: GitHubOperations): Promise<void> {
  const triage: IncidentTriage[] = [];
  let issuesFiled = 0;
  let ticketFailed = false;
  for (const item of state.triage ?? []) {
    if (item.ticket) {
      triage.push(item);
      continue;
    }
    try {
      const issue = await github.createIssue(buildIssueInput(item));
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
    await writeCursor(state.config.cursorPath, { offset: Bun.file(state.logPath).size });
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
      await github.replaceIssueLabel(number, "auto-fix-candidate", "needs-human");
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
): string {
  return [
    "## What changed",
    "",
    rewritePathsForPrBody(fix.description),
    "",
    `Files: ${formatPrFilesList(fix.filesChanged)}`,
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
): Promise<void> {
  const number = item.ticket?.issueNumber;
  if (number === undefined) throw new Error("pr requires an issue ticket");
  const short = `${item.incident.fingerprint.errName} on ${item.incident.fingerprint.route}`;
  const message = `fix: ${short} (bug-loop pipeline)\n\nFixes #${number}`;
  let pullRequest: PRRef | undefined;
  try {
    await worktrees.commit({ worktreeDir, message });
    await worktrees.push({ worktreeDir, branch: fix.branch });
    pullRequest = await github.createPullRequest({
      title: `[bug-loop] fix: ${short}`,
      body: pullRequestBody(item, fix, verify, number),
      head: fix.branch,
      base: "main",
      labels: ["bug-loop"],
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
): Promise<void> {
  const fingerprint8 = item.incident.fingerprint.hash.slice(0, 8);
  const branch = `bugloop/fix-${fingerprint8}`;
  const created = await worktrees.create({ branch, fingerprint8 });
  const generatedIssue = buildIssueInput(item);
  let previousFailure: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let issue: IssueDetails | null = null;
    try {
      issue = await github.readIssue(item.ticket?.issueNumber ?? 0);
    } catch (error: unknown) {
      console.warn(`[fix] issue read failed; using generated issue body: ${errorDetail(error)}`);
    }

    let fix: FixAttempt;
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
    } catch (error: unknown) {
      fix = {
        attempt,
        branch,
        description: `Fixer failed: ${errorDetail(error)}`,
        filesChanged: [],
      };
    }
    state.fixAttempts = [...state.fixAttempts ?? [], fix];
    console.log(`[fix] fingerprint=${fingerprint8} attempt=${attempt} files=${fix.filesChanged.length}`);

    const verifyState = activeState(state, item, created.worktreeDir, fix, attempt - 1);
    const verified = await verifyWithRunner(verifyState, verifier);
    const result = verified.activeVerify;
    if (!result) throw new Error("verify did not return a result");
    state.verifyResults = verified.verifyResults ?? state.verifyResults;
    console.log(`[verify] fingerprint=${fingerprint8} attempt=${attempt} verified=${result.verified}`);
    if (result.verified) {
      await openPullRequest(
        state,
        github,
        worktrees,
        item,
        created.worktreeDir,
        fix,
        result,
      );
      return;
    }
    previousFailure = result.detail;
  }

  await giveUp(
    state,
    github,
    worktrees,
    item,
    created.worktreeDir,
    2,
    previousFailure ?? "Verification did not provide details.",
  );
}

export async function runAgentSdkPipeline(
  options: AgentSdkPipelineOptions,
  dependencies: PipelineDependencies = {},
): Promise<AgentSdkPipelineResult> {
  const repoRoot = dependencies.repoRoot ?? resolve(import.meta.dir, "../../..");
  const github = dependencies.github ?? defaultGitHub;
  const state = initialState(options);

  await ingest(state);
  detect(state);
  await dedupe(state, github);
  if (state.incidents.length === 0) {
    return { state, summary: state.summary ?? EMPTY_SUMMARY };
  }
  await reproduce(state, dependencies.reproduce ?? reproduceIncident);
  await route(state, dependencies.triageAgent ?? new ClaudeTriageAgent(repoRoot));
  await ticket(state, github);

  if (state.config?.fix) {
    const fixer = dependencies.fixer ?? createDefaultFixer("grok");
    const verifier = dependencies.verifier ?? new RealVerifyRunner();
    const worktrees = dependencies.worktrees ?? new GitWorktreeOperations(repoRoot);
    const mechanical = (state.triage ?? []).filter(
      (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
    );
    for (const item of mechanical) {
      try {
        await fixIncident(state, item, fixer, verifier, worktrees, github);
      } catch (error: unknown) {
        state.errors.push(`fix ${item.incident.fingerprint.hash}: ${errorDetail(error)}`);
      }
    }
  }

  return { state, summary: state.summary ?? EMPTY_SUMMARY };
}

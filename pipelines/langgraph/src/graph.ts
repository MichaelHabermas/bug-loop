import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import {
  GitWorktreeOperations,
  RealVerifyRunner,
  type Fixer,
  type FixAttempt,
  type Incident,
  type IncidentTriage,
  type LogEvent,
  type PullRequestRef,
  type ReproResult,
  type TicketRef,
  type TriageRunConfig,
  type TriageState,
  type TriageSummary,
  type VerifyRunner,
  type VerifyResult,
  type WorktreeOperations,
} from "@bug-loop/core";
import {
  dedupeNode,
  detectNode,
  detectWithClassifier,
  ingestNode,
  reproduceNode,
  routeNode,
  routeWithClassifier,
  ticketNode,
  fixWithDependencies,
  giveUpWithDependencies,
  prWithDependencies,
  type GitHubOperations,
} from "./nodes";
import type { Classifier } from "./classifier";
import { verifyWithRunner } from "@bug-loop/core";
import { resolve } from "node:path";

const TriageAnnotation = Annotation.Root({
  logPath: Annotation<string>,
  events: Annotation<LogEvent[]>,
  actionableEvents: Annotation<LogEvent[]>,
  incidents: Annotation<Incident[]>,
  triage: Annotation<IncidentTriage[]>,
  config: Annotation<TriageRunConfig | undefined>,
  summary: Annotation<TriageSummary | undefined>,
  activeIncident: Annotation<Incident | null | undefined>,
  fixQueue: Annotation<Incident[] | undefined>,
  worktreeDir: Annotation<string | null | undefined>,
  activeRepro: Annotation<ReproResult | undefined>,
  activeTicket: Annotation<TicketRef | undefined>,
  activeFix: Annotation<FixAttempt | undefined>,
  activeVerify: Annotation<VerifyResult | undefined>,
  fixAttempts: Annotation<FixAttempt[] | undefined>,
  verifyResults: Annotation<VerifyResult[] | undefined>,
  pullRequests: Annotation<PullRequestRef[] | undefined>,
  retryCount: Annotation<number>,
  errors: Annotation<string[]>,
});

export interface InitialStateOptions extends TriageRunConfig {
  logPath: string;
}

export function createInitialState(options: InitialStateOptions): TriageState {
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
    retryCount: 0,
    errors: [],
  };
}

export interface GraphOptions {
  classifier?: Classifier;
  fixer?: Fixer;
  verifier?: VerifyRunner;
  worktrees?: WorktreeOperations;
  github?: GitHubOperations;
  repoRoot?: string;
}

export function routeAfterTicket(
  state: TriageState,
  triage = state.triage ?? [],
): "fix" | "end" {
  const hasMechanical = triage.some(
    (item) => item.route?.kind === "mechanical" && item.ticket !== undefined,
  );
  return state.config?.fix && hasMechanical ? "fix" : "end";
}

export function routeAfterVerify(state: TriageState): "pr" | "fix" | "give-up" {
  if (state.activeVerify?.verified) return "pr";
  return state.retryCount >= 2 ? "give-up" : "fix";
}

export function routeAfterIncident(state: TriageState): "fix" | "end" {
  return state.activeIncident ? "fix" : "end";
}

export function createTriageGraph(options: GraphOptions = {}) {
  const checkpointer = new MemorySaver();
  const classifier = options.classifier;
  const detect = classifier
    ? (state: TriageState) => detectWithClassifier(state, classifier)
    : detectNode;
  const route = classifier
    ? (state: TriageState) => routeWithClassifier(state, classifier)
    : routeNode;
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "../../..");
  const worktrees = options.worktrees ?? new GitWorktreeOperations(repoRoot);
  const verifier = options.verifier ?? new RealVerifyRunner();
  const fix = (state: TriageState) => fixWithDependencies(state, {
    fixer: options.fixer,
    worktrees,
    readIssue: options.github?.readIssue,
    repoRoot,
  });
  const verify = (state: TriageState) => verifyWithRunner(state, verifier);
  const giveUp = (state: TriageState) => giveUpWithDependencies(state, {
    github: options.github,
    worktrees,
    repoRoot,
  });
  const pr = (state: TriageState) => prWithDependencies(state, {
    github: options.github,
    worktrees,
    repoRoot,
  });
  return new StateGraph(TriageAnnotation)
    .addNode("ingest", ingestNode)
    .addNode("detect", detect)
    .addNode("dedupe", dedupeNode)
    .addNode("reproduce", reproduceNode)
    .addNode("route", route)
    .addNode("ticket", ticketNode)
    .addNode("fix", fix)
    .addNode("verify", verify)
    .addNode("give-up", giveUp)
    .addNode("pr", pr)
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
      (state) => (routeAfterTicket(state) === "fix" ? "fix" : END),
      ["fix", END],
    )
    .addEdge("fix", "verify")
    .addConditionalEdges(
      "verify",
      routeAfterVerify,
      ["pr", "fix", "give-up"],
    )
    .addConditionalEdges(
      "pr",
      (state) => (routeAfterIncident(state) === "fix" ? "fix" : END),
      ["fix", END],
    )
    .addConditionalEdges(
      "give-up",
      (state) => (routeAfterIncident(state) === "fix" ? "fix" : END),
      ["fix", END],
    )
    .compile({
      checkpointer,
      // Replace MemorySaver with a durable checkpointer when runs must survive process exit.
    });
}

/** Parsed structured log line supplied by a consumer application. */
import type { PipelineConfig } from "./config";
import type { IssueDetails } from "./github";

export type LogLevel = "info" | "warn" | "error";

export interface LogErr {
  name: string;
  message: string;
  stack?: string;
}

export interface LogEvent {
  ts: string;
  level: LogLevel;
  msg: string;
  reqId?: string;
  route?: string;
  status?: number;
  err?: LogErr;
}

/** Stable identity for an error cluster. */
export interface Fingerprint {
  hash: string;
  errName: string;
  topFrame: string;
  route: string;
}

/** Deduped incident: one fingerprint, up to 3 sample events. */
export interface Incident {
  fingerprint: Fingerprint;
  sampleEvents: LogEvent[];
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ReproResult {
  reproduced: boolean;
  command: string;
  evidence: string;
}

export interface TicketRef {
  issueNumber: number;
  url: string;
}

export type RegressionClaimClass =
  | "signature-absence"
  | "status-class"
  | "invariant"
  | "behavior";

export interface RegressionAssertionClaim {
  claim: string;
  class: RegressionClaimClass;
  source?: string;
}

export interface RegressionTestSpec {
  warranted: boolean;
  reason: string;
  mustPin: RegressionAssertionClaim[];
  mustNotPin: string[];
  suggestedLocation: string;
  unratifiedBehavior?: RegressionAssertionClaim[];
}

export type RouteDecision =
  | {
      kind: "mechanical";
      incidentClass: string;
      reason: string;
      fixBrief?: string;
      regressionTest?: RegressionTestSpec;
    }
  | {
      kind: "needs-human";
      reason: string;
      fixBrief?: string;
      regressionTest?: RegressionTestSpec;
    };

/** Result of running the reproducibility, routing, and ticket stages for one incident. */
export interface IncidentTriage {
  incident: Incident;
  repro?: ReproResult;
  route?: RouteDecision;
  ticket?: TicketRef;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** Runtime inputs shared by one-shot triage implementations. */
export interface TriageRunConfig {
  fromStart: boolean;
  nextCursorOffset?: number;
  /**
   * Exact byte offset to commit after a successful pass.
   * Watch mode sets this to the debounced batch end so mid-pass log growth
   * is not skipped; one-shot leaves it unset and commits at EOF.
   */
  commitCursorOffset?: number;
  fix?: boolean;
  live?: boolean;
  /** True when this pass is driven by the watch-mode daemon. */
  watch?: boolean;
}

/** Stable aggregate counters printed by pipeline implementations. */
export interface TriageSummary {
  eventsRead: number;
  actionable: number;
  incidents: number;
  newIncidents: number;
  reproduced: number;
  issuesFiled: number;
}

export interface FixAttempt {
  attempt: number;
  branch: string;
  description: string;
  filesChanged: string[];
  stageBaseCommit?: string;
}

export interface RegressionTestAttempt {
  attempt: number;
  description: string;
  filesChanged: string[];
}

export type RegressionTestStatus = "established" | "failed" | "skipped";

export interface RegressionTestRecord {
  spec: RegressionTestSpec;
  status: RegressionTestStatus;
  detail: string;
  filesChanged: string[];
  attempts: RegressionTestAttempt[];
  baselineEvidence?: string;
  redEvidence?: string;
  greenEvidence?: string;
  generationSource?: "fixture" | "agent";
  fixtureId?: string;
}

export interface VerifyResult {
  verified: boolean;
  scopePasses: boolean;
  reproPasses: boolean;
  testsPass: boolean;
  typecheckPasses: boolean;
  regressionTestPasses: boolean;
  reproEvidence?: string;
  testSummary?: string;
  typecheckDetail?: string;
  regressionTestDetail?: string;
  detail: string;
}

/**
 * Full pipeline state threaded through every stage.
 * Both LangGraph and Agent-SDK implementations share this shape.
 */
export interface TriageState {
  logPath: string;
  pipelineConfig?: PipelineConfig;
  events: LogEvent[];
  actionableEvents?: LogEvent[];
  incidents: Incident[];
  triage?: IncidentTriage[];
  config?: TriageRunConfig;
  summary?: TriageSummary;
  activeIncident?: Incident | null;
  fixQueue?: Incident[];
  worktreeDir?: string | null;
  worktreeBaseCommit?: string;
  pipelineHeadCommit?: string;
  activeRepro?: ReproResult;
  activeTicket?: TicketRef;
  activeIssue?: IssueDetails | null;
  activeFix?: FixAttempt;
  activeRegressionTest?: RegressionTestRecord;
  activeVerify?: VerifyResult;
  fixAttempts?: FixAttempt[];
  regressionTestAttempts?: RegressionTestAttempt[];
  verifyResults?: VerifyResult[];
  pullRequests?: PullRequestRef[];
  retryCount: number;
  errors: string[];
}

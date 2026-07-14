/** Parsed structured log line from leaky-service. */
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

export type RouteKind = "mechanical" | "needs-human";

export interface RouteDecision {
  kind: RouteKind;
  reason: string;
}

/** Result of running the reproducibility, routing, and ticket stages for one incident. */
export interface IncidentTriage {
  incident: Incident;
  repro?: ReproResult;
  route?: RouteDecision;
  ticket?: TicketRef;
}

/** Runtime inputs shared by one-shot triage implementations. */
export interface TriageRunConfig {
  cursorPath: string;
  fromStart: boolean;
  baseUrl: string;
  nextCursorOffset?: number;
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
  branch: string;
  description: string;
  filesChanged: string[];
}

export interface VerifyResult {
  reproPasses: boolean;
  testsPass: boolean;
  detail: string;
}

/**
 * Full pipeline state threaded through every stage.
 * Both LangGraph and Agent-SDK implementations share this shape.
 */
export interface TriageState {
  logPath: string;
  events: LogEvent[];
  actionableEvents?: LogEvent[];
  incidents: Incident[];
  triage?: IncidentTriage[];
  config?: TriageRunConfig;
  summary?: TriageSummary;
  activeIncident?: Incident;
  repro?: ReproResult;
  ticket?: TicketRef;
  route?: RouteDecision;
  fix?: FixAttempt;
  verify?: VerifyResult;
  retryCount: number;
  errors: string[];
}

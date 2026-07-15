export type {
  LogLevel,
  LogErr,
  LogEvent,
  Fingerprint,
  Incident,
  ReproResult,
  TicketRef,
  PullRequestRef,
  RouteDecision,
  RegressionTestSpec,
  RegressionAssertionClaim,
  RegressionClaimClass,
  RegressionTestAttempt,
  RegressionTestRecord,
  RegressionTestStatus,
  IncidentTriage,
  TriageRunConfig,
  TriageSummary,
  FixAttempt,
  VerifyResult,
  TriageState,
} from "./types";

export { routeIncident } from "./policy";
export type {
  RouteIncidentInput,
  RoutingPolicy,
  RoutingPolicyDecision,
  RoutingPolicyInput,
  UnknownRouteResolution,
  UnknownRouteResolver,
  UnknownRouteResolverInput,
} from "./policy";

export { mapWithConcurrency } from "./concurrency";
export { runIncidentWorker, runIncidentWorkers } from "./incident-worker";
export type {
  IncidentBatchInput,
  IncidentOutcome,
  IncidentResult,
  IncidentWorkerInput,
} from "./incident-worker";

export {
  DEFAULT_WATCH_SETTINGS,
  definePipelineConfig,
  isPathInFixScope,
  isPathInScope,
  isPathInTestScope,
  resolveWatchSettings,
  watchPassLabel,
  watchTraceOutputPath,
} from "./config";
export type {
  PipelineConfig,
  PipelineConfigInput,
  PipelineLabels,
  ContractRegistryEntry,
  PipelineWorkloadDefinition,
  RegressionTestPolicy,
  WatchSettings,
} from "./config";

export { runWatchDaemon } from "./watch";
export type {
  WatchPassContext,
  WatchPassResult,
  WatchRunnerOptions,
  WatchRunnerResult,
} from "./watch";

export {
  issueLooksFixResolved,
  OUTCOME_FIXED_LABEL,
  OUTCOME_GAVE_UP_LABEL,
  shouldEnterWatchFixLoop,
} from "./watch-fix";

export {
  TraceRecorder,
  combineCostSamples,
  createAttemptId,
  createCorrelationId,
} from "./trace";
export type {
  CostSample,
  CostSource,
  AgentCall,
  AgentFallback,
  AgentUsage,
  PipelineKind,
  RecordAgentCallInput,
  ResolutionSource,
  ResolvedAgent,
  ResolvedPipeline,
  RunTrace,
  TraceWorkload,
  TraceEvent,
  TraceEventHandle,
  TraceIdentity,
  TraceRecorderOptions,
} from "./trace";

export {
  OPENROUTER_API_BASE,
  parseOpenRouterGenerationResponse,
  parseOpenRouterActivityResponse,
  parseOpenRouterModelsResponse,
  fetchOpenRouterGeneration,
  fetchOpenRouterActivityWindow,
  listOpenRouterModels,
  costSampleFromOpenRouterUsage,
  enrichOpenRouterCost,
  sumReportedUsd,
  shouldHaltBudget,
  reportedUsdFromTrace,
} from "./openrouter";
export type {
  FetchLike,
  OpenRouterClientOptions,
  OpenRouterGenerationUsage,
  OpenRouterModelInfo,
  CostEnrichmentSource,
  EnrichedOpenRouterCost,
} from "./openrouter";

export { resolvePipelineRuntime, resolveTraceWorkload } from "./runtime";
export type {
  ResolveRuntimeInput,
  RuntimeOverrides,
} from "./runtime";

export {
  normalizeFrame,
  topAppFrame,
  fingerprintEvent,
} from "./fingerprint";

export { readNewEvents, follow } from "./logtail";
export type { Cursor, ReadNewEventsOptions, ReadResult } from "./logtail";

export { readCursor, writeCursor, resolveCommitCursorOffset } from "./cursor";

export { runProcess, requireSuccess } from "./process";
export type { ProcessOptions, ProcessResult, ProcessRunner } from "./process";

export { GitWorktreeOperations } from "./worktree";
export type {
  WorktreeCreateInput,
  WorktreeCommitInput,
  WorktreeProvenanceInput,
  WorktreeProvenanceResult,
  WorktreePushInput,
  WorktreeOperations,
} from "./worktree";

export {
  FakeFixer,
  CodexFixer,
  GrokFixer,
  OpenCodeFixer,
  FIX_SUMMARY_MARKER,
  extractFixSummary,
  buildFixPrompt,
  parseCliCost,
  parseGrokJsonOutput,
  parseOpenCodeJsonOutput,
  parseChangedFiles,
  configuredGrokEffort,
  configuredCodexModel,
  configuredOpenCodeModel,
  normalizeOpenCodeModel,
  createDefaultFixer,
  createResolvedFixer,
  takeFixerCost,
} from "./fixer";
export type {
  FixInput,
  FixOutput,
  Fixer,
  FixerKind,
  FakeFixCallback,
  GrokEffort,
  GrokJsonEnvelope,
  OpenCodeJsonParseResult,
  OpenCodeFixerOptions,
} from "./fixer";

export {
  FakeTestWriter,
  CodexTestWriter,
  GrokTestWriter,
  OpenCodeTestWriter,
  buildTestWriterPrompt,
  createDefaultTestWriter,
  createResolvedTestWriter,
  takeTestWriterCost,
} from "./test-writer";
export type {
  FakeTestWriterCallback,
  TestWriteInput,
  TestWriteOutput,
  TestWriter,
  TestWriterKind,
} from "./test-writer";

export {
  assessRegressionTestEligibility,
  authorizeRegressionTestSpec,
  formatRegressionTestIntent,
  heuristicRegressionTestSpec,
  runRegressionTestStage,
  shouldGenerateRegressionTest,
} from "./regression";
export type {
  RegressionFixtureMetadata,
  RegressionFixturePlan,
  RegressionFixtureWriteResult,
  RegressionTestEligibility,
  RegressionTestEligibilityInput,
  RegressionTestStageInput,
  RegressionTestStageResult,
  RegressionTestStrategy,
  RegressionTestStrategyInput,
} from "./regression";

export {
  PristineSuiteCache,
  RealVerifyRunner,
  reproCheckPasses,
  verifyWithRunner,
} from "./verifier";
export type {
  CheckResult,
  VerifyReproInput,
  VerifyRunner,
} from "./verifier";

export {
  isStructuredActionable,
  groupIncidents,
} from "./triage";

export { reproduceIncident } from "./reproduction";
export type {
  ReproduceInput,
  ReproPlan,
  ReproStrategy,
  ReproStrategyInput,
} from "./reproduction";

export { buildIssueInput } from "./ticket";

export {
  GitHubClient,
  toRepoRelativePath,
  rewritePathsForPrBody,
  formatPrFilesList,
  FINGERPRINT_MARKER,
  findOpenIssueByMarker,
  LABEL_CREATE_META,
  buildLabelCreateArgs,
  ensureLabelNonDestructive,
  isLabelAlreadyExistsError,
  labelListIncludes,
  parseLabelListNames,
} from "./github";
export type {
  IssueInput,
  PRInput,
  IssueRef,
  PRRef,
  IssueDetails,
  OpenIssue,
  GhCommandResult,
  GhRunner,
} from "./github";

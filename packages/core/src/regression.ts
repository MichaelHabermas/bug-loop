import type {
  ContractRegistryEntry,
  PipelineConfig,
  RegressionTestPolicy,
} from "./config";
import { isPathInTestScope } from "./config";
import type { CheckResult, VerifyRunner } from "./verifier";
import type { TestWriter } from "./test-writer";
import { takeTestWriterCost } from "./test-writer";
import type { TraceRecorder } from "./trace";
import { createAttemptId, createCorrelationId } from "./trace";
import type {
  Incident,
  RegressionTestAttempt,
  RegressionTestRecord,
  RegressionAssertionClaim,
  RegressionTestSpec,
  ReproResult,
  RouteDecision,
} from "./types";
import type { WorktreeOperations } from "./worktree";

export interface RegressionTestEligibility {
  eligible: boolean;
  detail: string;
}

export interface RegressionTestEligibilityInput {
  repro: ReproResult;
  route: RouteDecision;
  baseline: CheckResult;
}

export interface RegressionFixtureMetadata {
  fixtureId: string;
  incidentClass: string;
  contractSources: readonly string[];
}

export interface RegressionFixtureWriteResult {
  description: string;
  filesChanged: string[];
}

export interface RegressionFixturePlan {
  metadata: RegressionFixtureMetadata;
  spec: RegressionTestSpec;
  write(worktreeDir: string): Promise<RegressionFixtureWriteResult>;
}

export interface RegressionTestStrategyInput {
  incidentClass: string;
  incident: Incident;
  repro: ReproResult;
}

export interface RegressionTestStrategy {
  prepare(input: RegressionTestStrategyInput): RegressionFixturePlan | null;
}

function todoQuestion(route: RouteDecision, incident: Incident): string {
  const subject = `${incident.fingerprint.errName} on ${incident.fingerprint.route}`;
  return `What behavior should ${subject} require? ${route.reason}`;
}

export function heuristicRegressionTestSpec(
  route: RouteDecision,
  incident: Incident,
  repro: ReproResult,
  suggestedLocation: string,
): RegressionTestSpec {
  if (route.kind === "needs-human") {
    return {
      warranted: false,
      reason: `test.todo(${JSON.stringify(todoQuestion(route, incident))})`,
      mustPin: [],
      mustNotPin: ["behavior that has not been ratified by a human"],
      suggestedLocation,
    };
  }
  return {
    warranted: repro.reproduced,
    reason: repro.reproduced
      ? "A deterministic mechanical failure is not covered by the passing suite."
      : "The failure is not deterministic enough to establish a behavioral regression test.",
    mustPin: [
      {
        claim: "the response stays outside the 5xx status-code class",
        class: "status-class",
      },
      {
        claim: `the ${incident.fingerprint.errName} failure signature is absent`,
        class: "signature-absence",
      },
    ],
    mustNotPin: [
      "exact response message text",
      "timestamps",
      "generated IDs",
      "result ordering unless ordering is the contract",
    ],
    suggestedLocation,
  };
}

export function authorizeRegressionTestSpec(
  spec: RegressionTestSpec,
  contractRegistry: ContractRegistryEntry[],
): RegressionTestSpec {
  const authorizedSources = new Set(contractRegistry.map((contract) => contract.id));
  const mustPin: RegressionAssertionClaim[] = [];
  const unratifiedBehavior: RegressionAssertionClaim[] = [];
  for (const assertion of spec.mustPin) {
    if (
      assertion.class === "behavior" &&
      (assertion.source === undefined || !authorizedSources.has(assertion.source))
    ) {
      unratifiedBehavior.push(assertion);
    } else {
      mustPin.push(assertion);
    }
  }
  return {
    ...spec,
    mustPin,
    unratifiedBehavior: [
      ...(spec.unratifiedBehavior ?? []),
      ...unratifiedBehavior,
    ],
  };
}

export function assessRegressionTestEligibility(
  input: RegressionTestEligibilityInput,
): RegressionTestEligibility {
  if (input.route.kind !== "mechanical") {
    return { eligible: false, detail: "ineligible: needs-human incidents cannot pin behavior" };
  }
  if (!input.repro.reproduced) {
    return { eligible: false, detail: "ineligible: the incident did not reproduce deterministically" };
  }
  if (!input.baseline.passes) {
    return {
      eligible: false,
      detail: `ineligible: the pre-fix suite is already red - ${input.baseline.detail}`,
    };
  }
  return {
    eligible: true,
    detail: `eligible: deterministic repro and green pre-fix suite - ${input.baseline.detail}`,
  };
}

export function shouldGenerateRegressionTest(
  policy: RegressionTestPolicy,
  eligibility: RegressionTestEligibility,
  spec: RegressionTestSpec,
): boolean {
  if (policy === "never" || !eligibility.eligible) return false;
  return policy === "always" || spec.warranted;
}

export interface RegressionTestStageInput {
  config: PipelineConfig;
  worktreeDir: string;
  incident: Incident;
  repro: ReproResult;
  route: RouteDecision;
  writer?: TestWriter;
  createWriter?: () => TestWriter;
  strategy?: RegressionTestStrategy;
  pristineSuiteCache?: import("./verifier").PristineSuiteCache;
  verifier: VerifyRunner;
  worktrees: WorktreeOperations;
  baseCommit: string;
  expectedHead: string;
  recorder?: TraceRecorder;
}

export interface RegressionTestStageResult {
  record: RegressionTestRecord;
  eligibility: RegressionTestEligibility;
  pipelineHeadCommit: string;
}

function skippedRecord(
  spec: RegressionTestSpec,
  detail: string,
  baselineEvidence?: string,
): RegressionTestRecord {
  return {
    spec,
    status: "skipped",
    detail,
    filesChanged: [],
    attempts: [],
    ...(baselineEvidence === undefined ? {} : { baselineEvidence }),
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeCheck(check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check();
  } catch (error: unknown) {
    return { passes: false, detail: errorDetail(error) };
  }
}

export async function runRegressionTestStage(
  input: RegressionTestStageInput,
): Promise<RegressionTestStageResult> {
  const correlationId = input.recorder
    ? createCorrelationId(input.recorder.runId, input.incident.fingerprint.hash)
    : undefined;
  const fixture = input.route.kind === "mechanical"
    ? input.strategy?.prepare({
        incidentClass: input.route.incidentClass,
        incident: input.incident,
        repro: input.repro,
      }) ?? null
    : null;
  const proposedSpec = fixture?.spec ?? input.route.regressionTest ?? heuristicRegressionTestSpec(
    input.route,
    input.incident,
    input.repro,
    input.config.testScope[0] ?? "test",
  );
  const spec = authorizeRegressionTestSpec(proposedSpec, input.config.contractRegistry);
  if (input.config.regressionTests === "never") {
    return {
      eligibility: { eligible: false, detail: "regression tests disabled by policy" },
      record: skippedRecord(spec, "regression tests disabled by policy"),
      pipelineHeadCommit: input.expectedHead,
    };
  }
  if (input.config.regressionTests === "triage-decides" && !spec.warranted) {
    return {
      eligibility: { eligible: false, detail: `triage declined: ${spec.reason}` },
      record: skippedRecord(spec, `triage declined: ${spec.reason}`),
      pipelineHeadCommit: input.expectedHead,
    };
  }

  const baselineEvent = input.recorder?.start(
    "verify-test-eligibility",
    input.incident.fingerprint.hash,
    correlationId === undefined ? undefined : { correlationId },
  );
  const baseline = input.pristineSuiteCache
    ? await input.pristineSuiteCache.get(
        input.baseCommit,
        () => input.verifier.runTests(input.worktreeDir),
      )
    : await safeCheck(() => input.verifier.runTests(input.worktreeDir));
  const eligibility = assessRegressionTestEligibility({
    repro: input.repro,
    route: input.route,
    baseline,
  });
  baselineEvent?.finish(eligibility.eligible ? "eligible" : "ineligible", {
    suitePasses: baseline.passes,
    detail: eligibility.detail,
  });
  if (!shouldGenerateRegressionTest(input.config.regressionTests, eligibility, spec)) {
    const reason = eligibility.eligible
      ? `triage declined: ${spec.reason}`
      : eligibility.detail;
    return {
      eligibility,
      record: skippedRecord(spec, reason, baseline.detail),
      pipelineHeadCommit: input.expectedHead,
    };
  }

  const effectiveSpec = input.config.regressionTests === "always"
    ? { ...spec, warranted: true }
    : spec;
  const attempts: RegressionTestAttempt[] = [];
  let previousFailure: string | undefined;
  let writer = input.writer;
  const maxAttempts = fixture ? 1 : input.config.maxFixAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptId = correlationId === undefined
      ? undefined
      : createAttemptId(correlationId, "testgen", attempt);
    const identity = correlationId === undefined
      ? undefined
      : {
          correlationId,
          ...(attemptId === undefined ? {} : { attemptId }),
          ...(fixture ? { recordAgentCall: false } : {}),
        };
    const testgenEvent = input.recorder?.start(
      "testgen",
      input.incident.fingerprint.hash,
      identity,
    );
    let output: RegressionTestAttempt;
    try {
      const written = fixture
        ? await fixture.write(input.worktreeDir)
        : await (async () => {
            writer ??= input.createWriter?.();
            if (!writer) throw new Error("regression test generation requires a TestWriter");
            return writer.write({
              worktreeDir: input.worktreeDir,
              incident: input.incident,
              repro: input.repro,
              assertionSpec: effectiveSpec,
              attempt,
              ...(previousFailure === undefined ? {} : { previousFailure }),
            });
          })();
      output = { attempt, ...written };
      testgenEvent?.finish(
        `attempt ${attempt}`,
        { attempt, filesChanged: written.filesChanged },
        fixture || !writer ? undefined : takeTestWriterCost(writer),
      );
    } catch (error: unknown) {
      output = {
        attempt,
        description: `TestWriter failed: ${errorDetail(error)}`,
        filesChanged: [],
      };
      testgenEvent?.finish(
        "error",
        { attempt, error: errorDetail(error) },
        fixture || !writer ? undefined : takeTestWriterCost(writer),
      );
    }
    attempts.push(output);

    const provenance = await input.worktrees.verifyProvenance({
      worktreeDir: input.worktreeDir,
      baseCommit: input.baseCommit,
      expectedHead: input.expectedHead,
      scope: input.config.testScope,
    });
    const scopePasses = provenance.passes && output.filesChanged.length > 0 &&
      output.filesChanged.every((path) => isPathInTestScope(path, input.config.testScope));
    const redEvent = input.recorder?.start(
      "verify-test-red",
      input.incident.fingerprint.hash,
      identity,
    );
    const red = scopePasses && input.verifier.runTestFiles
      ? await safeCheck(() => input.verifier.runTestFiles!(input.worktreeDir, output.filesChanged))
      : {
          passes: true,
          detail: scopePasses
            ? "the verifier cannot run selected test files"
            : "test-writer changes escaped testScope",
        };
    const redPasses = scopePasses && !red.passes;
    const detail = [
      `scope: ${scopePasses ? "pass" : "fail"} - ${provenance.detail}`,
      `red: ${redPasses ? "pass" : "fail"} - ${red.detail}`,
    ].join("\n");
    redEvent?.finish(redPasses ? "red established" : "rejected", {
      attempt,
      scopePasses,
      testPassedOnBase: red.passes,
      detail: red.detail,
    });

    if (redPasses) {
      const committed = await input.worktrees.commit({
        worktreeDir: input.worktreeDir,
        message: `test: reproduce ${input.incident.fingerprint.errName} regression`,
        scope: "test",
      });
      return {
        eligibility,
        record: {
          spec: effectiveSpec,
          status: "established",
          detail,
          filesChanged: output.filesChanged,
          attempts,
          baselineEvidence: baseline.detail,
          redEvidence: red.detail,
          generationSource: fixture ? "fixture" : "agent",
          ...(fixture ? { fixtureId: fixture.metadata.fixtureId } : {}),
        },
        pipelineHeadCommit: committed.commit,
      };
    }

    previousFailure = detail;
    await input.worktrees.reset(input.worktreeDir, input.expectedHead);
  }

  return {
    eligibility,
    record: {
      spec: effectiveSpec,
      status: "failed",
      detail: previousFailure ?? "regression test could not be established",
      filesChanged: [],
      attempts,
      baselineEvidence: baseline.detail,
      generationSource: fixture ? "fixture" : "agent",
      ...(fixture ? { fixtureId: fixture.metadata.fixtureId } : {}),
    },
    pipelineHeadCommit: input.expectedHead,
  };
}

export function formatRegressionTestIntent(record: RegressionTestRecord | undefined): string {
  if (!record) {
    return [
      "## Regression test intent",
      "",
      "Regression test intent was not recorded.",
    ].join("\n");
  }
  const mustPin = record.spec.mustPin.length === 0
    ? ["- none until a human ratifies behavior"]
    : record.spec.mustPin.map((item) =>
        `- [${item.class}] ${item.claim}${item.source === undefined ? "" : ` (source: ${item.source})`}`
      );
  const mustNotPin = record.spec.mustNotPin.length === 0
    ? ["- none recorded"]
    : record.spec.mustNotPin.map((item) => `- ${item}`);
  const outcome = record.status === "failed"
    ? "regression test could not be established"
    : `Status: ${record.status}`;
  const unratified = record.spec.unratifiedBehavior ?? [];
  return [
    "## Regression test intent",
    "",
    outcome,
    "",
    `Reason: ${record.spec.reason}`,
    `Suggested location: ${record.spec.suggestedLocation}`,
    "",
    "### Must pin",
    "",
    ...mustPin,
    "",
    "### Must not pin",
    "",
    ...mustNotPin,
    ...(unratified.length === 0
      ? []
      : [
          "",
          "### Unratified behavior (not pinned - needs human ratification)",
          "",
          ...unratified.map((item) => `- test.todo(${JSON.stringify(item.claim)})`),
        ]),
    ...(record.redEvidence === undefined ? [] : ["", `RED on base: ${record.redEvidence}`]),
    ...(record.greenEvidence === undefined ? [] : ["", `GREEN after fix: ${record.greenEvidence}`]),
  ].join("\n");
}

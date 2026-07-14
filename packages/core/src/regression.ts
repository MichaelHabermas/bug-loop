import { isPathInTestScope } from "./config";
import type { PipelineConfig, RegressionTestPolicy } from "./config";
import type { CheckResult, VerifyRunner } from "./verifier";
import type { TestWriter } from "./test-writer";
import { takeTestWriterCost } from "./test-writer";
import type { TraceRecorder } from "./trace";
import type {
  Incident,
  RegressionTestAttempt,
  RegressionTestRecord,
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
      "the response stays outside the 5xx status-code class",
      `the ${incident.fingerprint.errName} failure signature is absent`,
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
  verifier: VerifyRunner;
  worktrees: WorktreeOperations;
  recorder?: TraceRecorder;
}

export interface RegressionTestStageResult {
  record: RegressionTestRecord;
  eligibility: RegressionTestEligibility;
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
  const spec = input.route.regressionTest ?? heuristicRegressionTestSpec(
    input.route,
    input.incident,
    input.repro,
    input.config.testScope[0] ?? "test",
  );
  if (input.config.regressionTests === "never") {
    return {
      eligibility: { eligible: false, detail: "regression tests disabled by policy" },
      record: skippedRecord(spec, "regression tests disabled by policy"),
    };
  }
  if (input.config.regressionTests === "triage-decides" && !spec.warranted) {
    return {
      eligibility: { eligible: false, detail: `triage declined: ${spec.reason}` },
      record: skippedRecord(spec, `triage declined: ${spec.reason}`),
    };
  }

  const baselineEvent = input.recorder?.start(
    "verify-test-eligibility",
    input.incident.fingerprint.hash,
  );
  const baseline = await safeCheck(() => input.verifier.runTests(input.worktreeDir));
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
    };
  }

  const effectiveSpec = input.config.regressionTests === "always"
    ? { ...spec, warranted: true }
    : spec;
  const attempts: RegressionTestAttempt[] = [];
  let previousFailure: string | undefined;
  let writer = input.writer;

  for (let attempt = 1; attempt <= input.config.maxFixAttempts; attempt += 1) {
    const testgenEvent = input.recorder?.start("testgen", input.incident.fingerprint.hash);
    let output: RegressionTestAttempt;
    try {
      writer ??= input.createWriter?.();
      if (!writer) throw new Error("regression test generation requires a TestWriter");
      const written = await writer.write({
        worktreeDir: input.worktreeDir,
        incident: input.incident,
        repro: input.repro,
        assertionSpec: effectiveSpec,
        attempt,
        ...(previousFailure === undefined ? {} : { previousFailure }),
      });
      output = { attempt, ...written };
      testgenEvent?.finish(
        `attempt ${attempt}`,
        { attempt, filesChanged: written.filesChanged },
        takeTestWriterCost(writer),
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
        writer ? takeTestWriterCost(writer) : undefined,
      );
    }
    attempts.push(output);

    const scopePasses = output.filesChanged.length > 0 && output.filesChanged.every(
      (path) => isPathInTestScope(path, input.config.testScope),
    );
    const redEvent = input.recorder?.start("verify-test-red", input.incident.fingerprint.hash);
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
      `scope: ${scopePasses ? "pass" : "fail"} - ${output.filesChanged.join(", ") || "no changed files recorded"}`,
      `red: ${redPasses ? "pass" : "fail"} - ${red.detail}`,
    ].join("\n");
    redEvent?.finish(redPasses ? "red established" : "rejected", {
      attempt,
      scopePasses,
      testPassedOnBase: red.passes,
      detail: red.detail,
    });

    if (redPasses) {
      await input.worktrees.commit({
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
        },
      };
    }

    previousFailure = detail;
    await input.worktrees.reset(input.worktreeDir);
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
    },
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
    : record.spec.mustPin.map((item) => `- ${item}`);
  const mustNotPin = record.spec.mustNotPin.length === 0
    ? ["- none recorded"]
    : record.spec.mustNotPin.map((item) => `- ${item}`);
  const outcome = record.status === "failed"
    ? "regression test could not be established"
    : `Status: ${record.status}`;
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
    ...(record.redEvidence === undefined ? [] : ["", `RED on base: ${record.redEvidence}`]),
    ...(record.greenEvidence === undefined ? [] : ["", `GREEN after fix: ${record.greenEvidence}`]),
  ].join("\n");
}

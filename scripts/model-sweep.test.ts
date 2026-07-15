import { expect, test } from "bun:test";
import {
  checkBudgetAfterTrial,
  modelShortName,
  openRouterModelToOpenCode,
  parseModelSweepConfig,
  planSweepTrials,
  trialUsdFromTraceFile,
} from "./model-sweep";

test("parseModelSweepConfig reads models and budget fields", () => {
  const config = parseModelSweepConfig({
    models: ["deepseek/deepseek-v4-pro", "qwen/qwen3-coder"],
    trials: 3,
    budgetHaltUsd: 18,
    budgetCapUsd: 20,
    trafficCount: 50,
    seedBase: 100,
  });
  expect(config.models).toHaveLength(2);
  expect(config.budgetHaltUsd).toBe(18);
  expect(config.budgetCapUsd).toBe(20);
});

test("planSweepTrials builds full matrix with rotating seeds and labels", () => {
  const plans = planSweepTrials({
    models: ["deepseek/deepseek-v4-pro", "qwen/qwen3-coder"],
    trials: 3,
    budgetHaltUsd: 18,
    budgetCapUsd: 20,
    trafficCount: 50,
    seedBase: 100,
  });
  expect(plans).toHaveLength(6);
  expect(plans[0]).toMatchObject({
    label: "or-deepseek-v4-pro-t1",
    seed: 100,
    openCodeModel: "openrouter/deepseek/deepseek-v4-pro",
    trial: 1,
  });
  expect(plans[3]).toMatchObject({
    label: "or-qwen3-coder-t1",
    seed: 103,
  });
  expect(plans.map((p) => p.seed)).toEqual([100, 101, 102, 103, 104, 105]);
});

test("pilot flag yields 1 model × 1 trial", () => {
  const plans = planSweepTrials(
    {
      models: [
        "deepseek/deepseek-v4-pro",
        "qwen/qwen3-coder",
        "z-ai/glm-5.2",
      ],
      trials: 3,
      budgetHaltUsd: 18,
      budgetCapUsd: 20,
      trafficCount: 50,
      seedBase: 100,
    },
    { pilot: true },
  );
  expect(plans).toHaveLength(1);
  expect(plans[0]?.modelId).toBe("deepseek/deepseek-v4-pro");
  expect(plans[0]?.trial).toBe(1);
  expect(plans[0]?.label).toBe("or-deepseek-v4-pro-t1");
});

test("budget-halt arithmetic: cumulative > $18 stops; equal does not", () => {
  const under = checkBudgetAfterTrial({
    cumulativeUsd: 17.5,
    trialUsd: 0.4,
    haltAtUsd: 18,
    capUsd: 20,
    label: "or-x-t1",
  });
  expect(under.halt).toBe(false);
  expect(under.cumulativeUsd).toBeCloseTo(17.9);

  const atLimit = checkBudgetAfterTrial({
    cumulativeUsd: 17.5,
    trialUsd: 0.5,
    haltAtUsd: 18,
    capUsd: 20,
    label: "or-x-t2",
  });
  expect(atLimit.halt).toBe(false);
  expect(atLimit.cumulativeUsd).toBeCloseTo(18);

  const over = checkBudgetAfterTrial({
    cumulativeUsd: 17.5,
    trialUsd: 0.6,
    haltAtUsd: 18,
    capUsd: 20,
    label: "or-x-t3",
  });
  expect(over.halt).toBe(true);
  expect(over.cumulativeUsd).toBeCloseTo(18.1);
  expect(over.message).toContain("BUDGET HALT");
  expect(over.message).toContain("or-x-t3");
  expect(over.message).toContain("$18.00");
  expect(over.message).toContain("$20.00");
});

test("trialUsdFromTraceFile sums reported agentCalls only", () => {
  const usd = trialUsdFromTraceFile({
    events: [{ cost: { usd: 9 } }],
    agentCalls: [
      { usage: { status: "reported", usd: 1.25 } },
      { usage: { status: "tokens-only", usd: undefined } },
      { usage: { status: "reported", usd: 0.25 } },
    ],
  });
  expect(usd).toBeCloseTo(1.5);
});

test("model short names and openrouter prefix", () => {
  expect(modelShortName("nvidia/nemotron-3-super-120b-a12b")).toBe(
    "nemotron-3-super-120b-a12b",
  );
  expect(openRouterModelToOpenCode("qwen/qwen3-coder")).toBe(
    "openrouter/qwen/qwen3-coder",
  );
});

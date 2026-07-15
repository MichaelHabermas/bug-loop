import { expect, test } from "bun:test";
import { definePipelineConfig, resolvePipelineRuntime } from "../src";

const config = definePipelineConfig({
  repo: "example/repo",
  labels: { pipeline: "pipeline", mechanical: "mechanical", needsHuman: "human" },
  logPath: "logs/app.jsonl",
  baseUrl: "http://localhost:3000",
  cursorPath: ".cursor.json",
  fixScope: ["src"],
  testScope: ["test"],
  worktreeRoot: ".worktrees",
  maxFixAttempts: 2,
  fixer: "grok",
  invariantWarnPrefixes: [],
});

test("runtime resolution snapshots env overrides before factories run", () => {
  const resolved = resolvePipelineRuntime({
    pipeline: "agent-sdk",
    config,
    mode: { fromStart: true, fix: true, live: false },
    env: {
      BUGLOOP_TRIAGE_MODEL: "haiku",
      BUGLOOP_FIXER: "codex",
      BUGLOOP_CODEX_MODEL: "gpt-5.6-luna",
      BUGLOOP_TESTWRITER: "grok",
      BUGLOOP_GROK_EFFORT: "low",
    },
  });

  expect(resolved).toMatchObject({
    pipeline: "agent-sdk",
    triage: {
      harness: "claude-agent-sdk",
      requestedModel: "haiku",
      effectiveModel: "haiku",
      source: "env",
    },
    fixer: {
      harness: "codex",
      requestedModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.6-luna",
      source: "env",
    },
    testWriter: { harness: "grok", effort: "low", source: "env" },
    mode: { fromStart: true, fix: true, live: false },
  });
});

test("injected implementations are labeled as argument-sourced", () => {
  const resolved = resolvePipelineRuntime({
    pipeline: "langgraph",
    config,
    mode: { fromStart: false },
    env: {},
    overrides: { triage: true, fixer: true, testWriter: true },
  });
  expect(resolved.triage).toMatchObject({ harness: "injected", source: "arg" });
  expect(resolved.fixer).toMatchObject({ harness: "injected", source: "arg" });
  expect(resolved.testWriter).toMatchObject({ harness: "injected", source: "arg" });
});

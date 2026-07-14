# @bug-loop/core

`@bug-loop/core` is the app-agnostic kit behind bug-loop pipelines.
It provides JSONL ingestion, fingerprinting, incident grouping, ticket shaping, fixer interfaces, worktree lifecycle, verification policy, and run tracing.

## Consumer contract

A consumer supplies three things:

1. A `PipelineConfig` created with `definePipelineConfig`.
2. A `ReproStrategy` that derives app-specific reproduction and verification requests from incident samples.
3. Structured JSONL logs matching `LogEvent`.

`PipelineConfig` owns repository coordinates, labels, paths, writer boundaries, retry policy, and regression-test policy.
`fixScope` and `testScope` are disjoint and are independently enforced in writer prompts, verification, and worktree commits.
`invariantWarnPrefixes` selects warning-level business invariants while all error events remain actionable.

`ReproStrategy` may normalize app-specific events before fingerprinting.
Its `derive` method returns a command plus pre-fix and post-fix checks, or `null` when no safe reproduction exists.
Core treats an absent derivation as `reproduced: false` and routes conservatively.

`Fixer`, `TestWriter`, and `TriageAgent` remain injectable seams.
The built-in Codex and Grok writers capture CLI usage when their stdout exposes it.

Every CLI run writes a pretty-printed `RunTrace` under `traces/`.
Use `--trace <path>` to choose a different destination.
Trace events include stage timing, outcomes, per-attempt fix and verify details, fingerprints, and best-effort cost samples.

See `apps/leaky-service/src/bug-loop.ts` for the demo consumer implementation.

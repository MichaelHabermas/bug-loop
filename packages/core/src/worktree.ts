import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPathInScope } from "./config";
import { requireSuccess, runProcess } from "./process";
import type { ProcessRunner } from "./process";

export interface WorktreeCreateInput {
  branch: string;
  fingerprint8: string;
}

export interface WorktreeProvenanceInput {
  worktreeDir: string;
  baseCommit: string;
  expectedHead: string;
  scope: string[];
}

export interface WorktreeProvenanceResult {
  passes: boolean;
  changedPaths: string[];
  outOfScopePaths: string[];
  unexpectedCommits: string[];
  detail: string;
}

export interface WorktreeCommitInput {
  worktreeDir: string;
  message: string;
  scope?: "fix" | "test";
}

export interface WorktreePushInput {
  worktreeDir: string;
  branch: string;
}

export interface WorktreeOperations {
  create(input: WorktreeCreateInput): Promise<{
    worktreeDir: string;
    branch: string;
    baseCommit: string;
  }>;
  commit(input: WorktreeCommitInput): Promise<{ commit: string }>;
  push(input: WorktreePushInput): Promise<void>;
  remove(worktreeDir: string): Promise<void>;
  reset(worktreeDir: string, trustedCommit?: string): Promise<void>;
  verifyProvenance(input: WorktreeProvenanceInput): Promise<WorktreeProvenanceResult>;
}

function isDryRun(): boolean {
  return Bun.env["DRY_RUN"] === "1" || Bun.env["DRY_RUN"] === "true";
}

export class GitWorktreeOperations implements WorktreeOperations {
  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
    private readonly fixScope: string[],
    private readonly testScope: string[],
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async create(input: WorktreeCreateInput): Promise<{
    worktreeDir: string;
    branch: string;
    baseCommit: string;
  }> {
    const root = resolve(this.repoRoot, this.worktreeRoot);
    const worktreeDir = join(root, input.fingerprint8);
    await mkdir(root, { recursive: true });
    const baseCommand = ["git", "-C", this.repoRoot, "rev-parse", "main"];
    const base = await this.runner(baseCommand, { cwd: this.repoRoot });
    requireSuccess(baseCommand, base);
    const baseCommit = base.stdout.trim();
    // Fix branches are pipeline-owned scratch, so reset stale branches from failed runs.
    const command = [
      "git",
      "worktree",
      "add",
      worktreeDir,
      "-B",
      input.branch,
      baseCommit,
    ];
    const result = await this.runner(command, { cwd: this.repoRoot });
    requireSuccess(command, result);

    // Worktrees need local workspace links for tests and typecheck to resolve correctly.
    const installCommand = ["bun", "install"];
    const install = await this.runner(installCommand, { cwd: worktreeDir });
    requireSuccess(installCommand, install);
    return { worktreeDir, branch: input.branch, baseCommit };
  }

  async commit(input: WorktreeCommitInput): Promise<{ commit: string }> {
    const scope = input.scope === "test" ? this.testScope : this.fixScope;
    const addCommand = [
      "git",
      "-C",
      input.worktreeDir,
      "add",
      "--",
      ...scope,
    ];
    const add = await this.runner(addCommand, { cwd: input.worktreeDir });
    requireSuccess(addCommand, add);
    const commitCommand = ["git", "-C", input.worktreeDir, "commit", "-m", input.message];
    const commit = await this.runner(commitCommand, { cwd: input.worktreeDir });
    requireSuccess(commitCommand.slice(0, 5), commit);
    const headCommand = ["git", "-C", input.worktreeDir, "rev-parse", "HEAD"];
    const head = await this.runner(headCommand, { cwd: input.worktreeDir });
    requireSuccess(headCommand, head);
    return { commit: head.stdout.trim() };
  }

  async push(input: WorktreePushInput): Promise<void> {
    const command = [
      "git",
      "-C",
      input.worktreeDir,
      "push",
      "-u",
      "origin",
      input.branch,
    ];
    if (isDryRun()) {
      console.log(`[DRY_RUN] ${command.join(" ")}`);
      return;
    }
    const result = await this.runner(command, { cwd: input.worktreeDir });
    requireSuccess(command.slice(0, 5), result);
  }

  async remove(worktreeDir: string): Promise<void> {
    const command = ["git", "worktree", "remove", "--force", worktreeDir];
    const result = await this.runner(command, { cwd: this.repoRoot });
    requireSuccess(command, result);
  }

  async reset(worktreeDir: string, trustedCommit = "HEAD"): Promise<void> {
    const resetCommand = ["git", "-C", worktreeDir, "reset", "--hard", trustedCommit];
    const reset = await this.runner(resetCommand, { cwd: worktreeDir });
    requireSuccess(resetCommand, reset);
    const cleanCommand = ["git", "-C", worktreeDir, "clean", "-fd"];
    const clean = await this.runner(cleanCommand, { cwd: worktreeDir });
    requireSuccess(cleanCommand, clean);
  }

  async verifyProvenance(input: WorktreeProvenanceInput): Promise<WorktreeProvenanceResult> {
    const headCommand = ["git", "-C", input.worktreeDir, "rev-parse", "HEAD"];
    const head = await this.runner(headCommand, { cwd: input.worktreeDir });
    requireSuccess(headCommand, head);
    const actualHead = head.stdout.trim();

    const diffCommand = [
      "git",
      "-C",
      input.worktreeDir,
      "diff",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      input.baseCommit,
      "--",
    ];
    const diff = await this.runner(diffCommand, { cwd: input.worktreeDir });
    requireSuccess(diffCommand, diff);
    const untrackedCommand = [
      "git",
      "-C",
      input.worktreeDir,
      "ls-files",
      "--others",
      "--exclude-standard",
    ];
    const untracked = await this.runner(untrackedCommand, { cwd: input.worktreeDir });
    requireSuccess(untrackedCommand, untracked);
    const changedPaths = [...new Set(
      `${diff.stdout}\n${untracked.stdout}`.split("\n").map((path) => path.trim()).filter(Boolean),
    )].sort();
    const outOfScopePaths = changedPaths.filter((path) => !isPathInScope(path, input.scope));

    let unexpectedCommits: string[] = [];
    if (actualHead !== input.expectedHead) {
      const logCommand = [
        "git",
        "-C",
        input.worktreeDir,
        "log",
        "--format=%H%x09%s",
        `${input.expectedHead}..HEAD`,
      ];
      const log = await this.runner(logCommand, { cwd: input.worktreeDir });
      unexpectedCommits = log.exitCode === 0
        ? log.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [`HEAD ${actualHead} differs from trusted ${input.expectedHead}`];
      if (unexpectedCommits.length === 0) {
        unexpectedCommits = [`HEAD ${actualHead} differs from trusted ${input.expectedHead}`];
      }
    }

    const passes = changedPaths.length > 0 &&
      outOfScopePaths.length === 0 &&
      unexpectedCommits.length === 0;
    const detail = [
      `changed paths: ${changedPaths.join(", ") || "none"}`,
      `out-of-scope paths: ${outOfScopePaths.join(", ") || "none"}`,
      `unexpected commits: ${unexpectedCommits.join("; ") || "none"}`,
    ].join("\n");
    return { passes, changedPaths, outOfScopePaths, unexpectedCommits, detail };
  }
}

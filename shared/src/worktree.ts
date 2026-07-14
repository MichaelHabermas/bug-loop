import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requireSuccess, runProcess } from "./process";

export interface WorktreeCreateInput {
  branch: string;
  fingerprint8: string;
}

export interface WorktreeCommitInput {
  worktreeDir: string;
  message: string;
}

export interface WorktreePushInput {
  worktreeDir: string;
  branch: string;
}

export interface WorktreeOperations {
  create(input: WorktreeCreateInput): Promise<{ worktreeDir: string; branch: string }>;
  commit(input: WorktreeCommitInput): Promise<void>;
  push(input: WorktreePushInput): Promise<void>;
  remove(worktreeDir: string): Promise<void>;
}

function isDryRun(): boolean {
  return Bun.env["DRY_RUN"] === "1" || Bun.env["DRY_RUN"] === "true";
}

export class GitWorktreeOperations implements WorktreeOperations {
  constructor(private readonly repoRoot: string) {}

  async create(input: WorktreeCreateInput): Promise<{ worktreeDir: string; branch: string }> {
    const worktreeDir = join(this.repoRoot, ".worktrees", input.fingerprint8);
    await mkdir(join(this.repoRoot, ".worktrees"), { recursive: true });
    // Fix branches are pipeline-owned scratch, so reset stale branches from failed runs.
    const command = [
      "git",
      "worktree",
      "add",
      worktreeDir,
      "-B",
      input.branch,
      "main",
    ];
    const result = await runProcess(command, { cwd: this.repoRoot });
    requireSuccess(command, result);

    // Worktrees need local workspace links for tests and typecheck to resolve correctly.
    const installCommand = ["bun", "install"];
    const install = await runProcess(installCommand, { cwd: worktreeDir });
    requireSuccess(installCommand, install);
    return { worktreeDir, branch: input.branch };
  }

  async commit(input: WorktreeCommitInput): Promise<void> {
    const addCommand = [
      "git",
      "-C",
      input.worktreeDir,
      "add",
      "apps/leaky-service/src",
    ];
    const add = await runProcess(addCommand, { cwd: input.worktreeDir });
    requireSuccess(addCommand, add);
    const commitCommand = ["git", "-C", input.worktreeDir, "commit", "-m", input.message];
    const commit = await runProcess(commitCommand, { cwd: input.worktreeDir });
    requireSuccess(commitCommand.slice(0, 5), commit);
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
    const result = await runProcess(command, { cwd: input.worktreeDir });
    requireSuccess(command.slice(0, 5), result);
  }

  async remove(worktreeDir: string): Promise<void> {
    const command = ["git", "worktree", "remove", "--force", worktreeDir];
    const result = await runProcess(command, { cwd: this.repoRoot });
    requireSuccess(command, result);
  }
}

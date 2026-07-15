import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitWorktreeOperations } from "../src";

const tmpRoot = join(import.meta.dir, ".tmp-worktree-provenance");

async function git(...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", tmpRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

async function initializeRepository(): Promise<string> {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(join(tmpRoot, "src"), { recursive: true });
  await mkdir(join(tmpRoot, "test"), { recursive: true });
  await git("init", "-b", "main");
  await git("config", "user.email", "bug-loop@example.test");
  await git("config", "user.name", "Bug Loop Test");
  await writeFile(join(tmpRoot, "src", "app.ts"), "export const value = 1;\n");
  await git("add", "src/app.ts");
  await git("commit", "-m", "base");
  return git("rev-parse", "HEAD");
}

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("GitWorktreeOperations provenance", () => {
  test("rejects a writer commit containing an out-of-scope edit", async () => {
    const baseCommit = await initializeRepository();
    await writeFile(join(tmpRoot, "test", "unauthorized.test.ts"), "test.todo('unauthorized');\n");
    await git("add", "test/unauthorized.test.ts");
    await git("commit", "-m", "writer committed behind the pipeline");

    const worktrees = new GitWorktreeOperations(tmpRoot, ".worktrees", ["src"], ["test"]);
    const result = await worktrees.verifyProvenance({
      worktreeDir: tmpRoot,
      baseCommit,
      expectedHead: baseCommit,
      scope: ["src"],
    });

    expect(result.passes).toBe(false);
    expect(result.changedPaths).toContain("test/unauthorized.test.ts");
    expect(result.unexpectedCommits).toHaveLength(1);
    expect(result.detail).toContain("writer committed behind the pipeline");
  });

  test("accepts an uncommitted fix wholly inside the stage scope", async () => {
    const baseCommit = await initializeRepository();
    await writeFile(join(tmpRoot, "src", "app.ts"), "export const value = 2;\n");

    const worktrees = new GitWorktreeOperations(tmpRoot, ".worktrees", ["src"], ["test"]);
    const result = await worktrees.verifyProvenance({
      worktreeDir: tmpRoot,
      baseCommit,
      expectedHead: baseCommit,
      scope: ["src"],
    });

    expect(result).toMatchObject({
      passes: true,
      changedPaths: ["src/app.ts"],
      unexpectedCommits: [],
    });
  });
});

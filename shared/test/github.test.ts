import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  createIssue,
  findOpenIssueByMarker,
  createPullRequest,
  addLabels,
  formatPrFilesList,
  rewritePathsForPrBody,
  toRepoRelativePath,
  REPO,
} from "../src/github";

const originalDryRun = process.env["DRY_RUN"];

beforeEach(() => {
  process.env["DRY_RUN"] = "1";
});

afterEach(() => {
  if (originalDryRun === undefined) {
    delete process.env["DRY_RUN"];
  } else {
    process.env["DRY_RUN"] = originalDryRun;
  }
});

describe("github DRY_RUN", () => {
  test("createIssue returns fake ref", async () => {
    const ref = await createIssue({
      title: "TypeError on POST /orders",
      body: "bug-loop:fingerprint:abc123\n\nDetails here.",
      labels: ["bug", "auto-triaged"],
    });
    expect(ref.number).toBe(9001);
    expect(ref.url).toContain(REPO);
    expect(ref.url).toContain("/issues/9001");
  });

  test("findOpenIssueByMarker returns null in dry run", async () => {
    const found = await findOpenIssueByMarker("deadbeef");
    expect(found).toBeNull();
  });

  test("createPullRequest returns fake ref", async () => {
    const ref = await createPullRequest({
      title: "fix: null deref on POST /orders",
      body: "Closes #9001",
      head: "fix/typeerror-orders",
    });
    expect(ref.number).toBe(9002);
    expect(ref.url).toContain("/pull/9002");
  });

  test("addLabels is a no-op that does not throw", async () => {
    await addLabels(9001, ["needs-human"]);
  });
});

describe("PR body path rewriting", () => {
  const worktreeAbs =
    "/Users/michaelhabermas/repos/CaS-tests/bug-loop/.worktrees/45b905d3/apps/leaky-service/src/server.ts:60";

  test("toRepoRelativePath strips worktree absolute prefixes", () => {
    expect(toRepoRelativePath(worktreeAbs)).toBe(
      "apps/leaky-service/src/server.ts:60",
    );
    expect(toRepoRelativePath("apps/leaky-service/src/server.ts")).toBe(
      "apps/leaky-service/src/server.ts",
    );
  });

  test("rewritePathsForPrBody converts markdown absolute links to repo-relative plain text", () => {
    const description = `Fixed null guard in [server.ts](${worktreeAbs}).`;
    const rewritten = rewritePathsForPrBody(description);
    expect(rewritten).toBe(
      "Fixed null guard in apps/leaky-service/src/server.ts:60.",
    );
    expect(rewritten).not.toContain("/Users/");
    expect(rewritten).not.toContain(".worktrees/");
  });

  test("PR body built from worktree paths contains no local absolute prefixes", () => {
    const description = [
      "Root cause: missing null check.",
      `Changed [server.ts](${worktreeAbs}).`,
    ].join("\n");
    const filesChanged = [
      "/Users/michaelhabermas/repos/CaS-tests/bug-loop/.worktrees/45b905d3/apps/leaky-service/src/server.ts",
    ];

    const body = [
      "## What changed",
      "",
      rewritePathsForPrBody(description),
      "",
      `Files: ${formatPrFilesList(filesChanged)}`,
      "",
      "## Verification",
      "",
      "Fixes #1",
    ].join("\n");

    expect(body).toContain("apps/leaky-service/src/server.ts");
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain(".worktrees/");
  });
});

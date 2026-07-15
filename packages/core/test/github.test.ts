import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  OUTCOME_FIXED_LABEL,
  OUTCOME_GAVE_UP_LABEL,
} from "../src/watch-fix";
import {
  buildLabelCreateArgs,
  ensureLabelNonDestructive,
  formatPrFilesList,
  findOpenIssueByMarker,
  GitHubClient,
  isLabelAlreadyExistsError,
  LABEL_CREATE_META,
  labelListIncludes,
  parseLabelListNames,
  rewritePathsForPrBody,
  toRepoRelativePath,
  type GhRunner,
} from "../src/github";

const REPO = "MichaelHabermas/bug-loop";
const github = new GitHubClient(REPO);

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
    const ref = await github.createIssue({
      title: "TypeError on POST /orders",
      body: "bug-loop:fingerprint:abc123\n\nDetails here.",
      labels: ["bug", "auto-triaged"],
    });
    expect(ref.number).toBe(9001);
    expect(ref.url).toContain(REPO);
    expect(ref.url).toContain("/issues/9001");
  });

  test("findOpenIssueByMarker returns null in dry run", async () => {
    const found = await github.findOpenIssueByMarker("deadbeef");
    expect(found).toBeNull();
  });

  test("createPullRequest returns fake ref", async () => {
    const ref = await github.createPullRequest({
      title: "fix: null deref on POST /orders",
      body: "Closes #9001",
      head: "fix/typeerror-orders",
    });
    expect(ref.number).toBe(9002);
    expect(ref.url).toContain("/pull/9002");
  });

  test("addLabels is a no-op that does not throw", async () => {
    await github.addLabels(9001, ["needs-human"]);
  });

  test("ensureLabel is non-destructive in dry run (no --force)", async () => {
    await github.ensureLabel(OUTCOME_FIXED_LABEL);
  });
});

describe("ensureLabel lookup-or-create", () => {
  test("parseLabelListNames / labelListIncludes", () => {
    const stdout = JSON.stringify([
      { name: "needs-human" },
      { name: OUTCOME_FIXED_LABEL },
    ]);
    expect(parseLabelListNames(stdout)).toEqual([
      "needs-human",
      OUTCOME_FIXED_LABEL,
    ]);
    expect(labelListIncludes(stdout, "needs-human")).toBe(true);
    expect(labelListIncludes(stdout, OUTCOME_GAVE_UP_LABEL)).toBe(false);
    expect(labelListIncludes("", "x")).toBe(false);
    expect(labelListIncludes("not-json", "x")).toBe(false);
  });

  test("buildLabelCreateArgs never uses --force and sets outcome metadata", () => {
    const fixed = buildLabelCreateArgs(OUTCOME_FIXED_LABEL, REPO);
    expect(fixed).not.toContain("--force");
    expect(fixed).toEqual([
      "label",
      "create",
      OUTCOME_FIXED_LABEL,
      "--repo",
      REPO,
      "--color",
      LABEL_CREATE_META[OUTCOME_FIXED_LABEL]!.color,
      "--description",
      LABEL_CREATE_META[OUTCOME_FIXED_LABEL]!.description,
    ]);

    const gaveUp = buildLabelCreateArgs(OUTCOME_GAVE_UP_LABEL, REPO);
    expect(gaveUp).not.toContain("--force");
    expect(gaveUp).toContain(LABEL_CREATE_META[OUTCOME_GAVE_UP_LABEL]!.color);

    const other = buildLabelCreateArgs("needs-human", REPO);
    expect(other).not.toContain("--force");
    expect(other).toContain("--color");
    expect(other).not.toContain("--description");
  });

  test("existing label: list only, never create (preserves metadata)", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "label" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { name: "needs-human", color: "custom-color" },
            { name: OUTCOME_FIXED_LABEL },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    const result = await ensureLabelNonDestructive({
      name: "needs-human",
      repo: REPO,
      dryRun: false,
      run,
    });
    expect(result).toBe("exists");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("label");
    expect(calls[0]?.[1]).toBe("list");
    expect(calls.some((args) => args.includes("create"))).toBe(false);
    expect(calls.some((args) => args.includes("--force"))).toBe(false);
  });

  test("missing label: create without --force", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "label" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ name: "bug-loop" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "label" && args[1] === "create") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    const result = await ensureLabelNonDestructive({
      name: OUTCOME_GAVE_UP_LABEL,
      repo: REPO,
      dryRun: false,
      run,
    });
    expect(result).toBe("created");
    expect(calls).toHaveLength(2);
    const create = calls[1]!;
    expect(create[0]).toBe("label");
    expect(create[1]).toBe("create");
    expect(create).toContain(OUTCOME_GAVE_UP_LABEL);
    expect(create).not.toContain("--force");
    expect(create).toContain("--color");
    expect(create).toContain(LABEL_CREATE_META[OUTCOME_GAVE_UP_LABEL]!.color);
  });

  test("dry-run does not invoke runner", async () => {
    let invoked = false;
    const result = await ensureLabelNonDestructive({
      name: OUTCOME_FIXED_LABEL,
      repo: REPO,
      dryRun: true,
      run: async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      log: () => {},
    });
    expect(result).toBe("dry-run");
    expect(invoked).toBe(false);
  });

  test("isLabelAlreadyExistsError recognizes common gh messages", () => {
    expect(isLabelAlreadyExistsError("HTTP 422: label already exists")).toBe(true);
    expect(isLabelAlreadyExistsError("Name has already been taken (createLabel)")).toBe(true);
    expect(isLabelAlreadyExistsError('{"errors":[{"code":"already_exists"}]}')).toBe(true);
    expect(isLabelAlreadyExistsError("label name already been taken")).toBe(true);
    expect(isLabelAlreadyExistsError("network timeout")).toBe(false);
    expect(isLabelAlreadyExistsError("HTTP 403: forbidden")).toBe(false);
  });

  test("create already-exists (list cap miss / race) is treated as exists", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "label" && args[1] === "list") {
        // Cap miss: target not in the first 200 labels
        return {
          stdout: JSON.stringify([{ name: "unrelated-label" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "label" && args[1] === "create") {
        return {
          stdout: "",
          stderr: `HTTP 422: Validation Failed — label "${OUTCOME_FIXED_LABEL}" already exists`,
          exitCode: 1,
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    const result = await ensureLabelNonDestructive({
      name: OUTCOME_FIXED_LABEL,
      repo: REPO,
      dryRun: false,
      run,
    });
    expect(result).toBe("exists");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toBe("create");
  });

  test("create non-exists failure still throws", async () => {
    const run: GhRunner = async (args) => {
      if (args[0] === "label" && args[1] === "list") {
        return { stdout: JSON.stringify([]), stderr: "", exitCode: 0 };
      }
      if (args[0] === "label" && args[1] === "create") {
        return {
          stdout: "",
          stderr: "HTTP 403: Resource not accessible by integration",
          exitCode: 1,
        };
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    await expect(ensureLabelNonDestructive({
      name: OUTCOME_GAVE_UP_LABEL,
      repo: REPO,
      dryRun: false,
      run,
    })).rejects.toThrow(/gh label create failed.*403/);
  });
});

test("open issue markers are matched locally from one list snapshot", () => {
  const issues = [
    { number: 1, url: "https://example.test/1", body: "unrelated", labels: [] },
    {
      number: 2,
      url: "https://example.test/2",
      body: "bug-loop:fingerprint:deadbeef",
      labels: ["bug-loop"],
    },
  ];
  expect(findOpenIssueByMarker(issues, "deadbeef")).toEqual({
    number: 2,
    url: "https://example.test/2",
  });
  expect(findOpenIssueByMarker(issues, "missing")).toBeNull();
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
  expect(toRepoRelativePath(
    "/tmp/worktrees/custom/45b905d3/src/server.ts",
    "worktrees/custom",
  )).toBe("src/server.ts");
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

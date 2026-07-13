import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  createIssue,
  findOpenIssueByMarker,
  createPullRequest,
  addLabels,
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

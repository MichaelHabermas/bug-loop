const REPO = "MichaelHabermas/bug-loop";
const FINGERPRINT_MARKER = (hash: string) => `bug-loop:fingerprint:${hash}`;

export interface IssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface PRInput {
  title: string;
  body: string;
  head: string;
  base?: string;
  labels?: string[];
}

export interface IssueDetails {
  title: string;
  body: string;
}

export interface IssueRef {
  number: number;
  url: string;
}

export interface PRRef {
  number: number;
  url: string;
}

function isDryRun(): boolean {
  return process.env["DRY_RUN"] === "1" || process.env["DRY_RUN"] === "true";
}

async function runGh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/** Create a GitHub issue. In DRY_RUN mode returns a fake ref. */
export async function createIssue(input: IssueInput): Promise<IssueRef> {
  const args = [
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    input.title,
    "--body",
    input.body,
  ];
  for (const label of input.labels ?? []) {
    args.push("--label", label);
  }

  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return {
      number: 9001,
      url: `https://github.com/${REPO}/issues/9001`,
    };
  }

  const { stdout, stderr, exitCode } = await runGh(args);
  if (exitCode !== 0) {
    throw new Error(`gh issue create failed: ${stderr || stdout}`);
  }
  // gh prints the issue URL
  const url = stdout.trim();
  const match = url.match(/\/issues\/(\d+)/);
  const number = match?.[1] ? Number(match[1]) : 0;
  return { number, url };
}

/**
 * Find an open issue whose body contains the fingerprint marker
 * `bug-loop:fingerprint:<hash>`. Prevents duplicate tickets across runs.
 */
export async function findOpenIssueByMarker(hash: string): Promise<IssueRef | null> {
  const marker = FINGERPRINT_MARKER(hash);

  if (isDryRun()) {
    console.log(`[DRY_RUN] gh issue list --repo ${REPO} --state open --search marker:${marker}`);
    return null;
  }

  const { stdout, stderr, exitCode } = await runGh([
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--json",
    "number,url,body",
    "--limit",
    "50",
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh issue list failed: ${stderr || stdout}`);
  }

  interface GhIssue {
    number: number;
    url: string;
    body: string | null;
  }

  let issues: GhIssue[] = [];
  try {
    issues = JSON.parse(stdout) as GhIssue[];
  } catch {
    return null;
  }

  const found = issues.find((i) => (i.body ?? "").includes(marker));
  if (!found) return null;
  return { number: found.number, url: found.url };
}

/** Open a pull request. In DRY_RUN mode returns a fake ref. */
export async function createPullRequest(input: PRInput): Promise<PRRef> {
  const base = input.base ?? "main";
  const args = [
    "pr",
    "create",
    "--repo",
    REPO,
    "--title",
    input.title,
    "--body",
    input.body,
    "--head",
    input.head,
    "--base",
    base,
  ];
  for (const label of input.labels ?? []) {
    args.push("--label", label);
  }

  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return {
      number: 9002,
      url: `https://github.com/${REPO}/pull/9002`,
    };
  }

  const { stdout, stderr, exitCode } = await runGh(args);
  if (exitCode !== 0) {
    throw new Error(`gh pr create failed: ${stderr || stdout}`);
  }
  const url = stdout.trim();
  const match = url.match(/\/pull\/(\d+)/);
  const number = match?.[1] ? Number(match[1]) : 0;
  return { number, url };
}

/** Add labels to an issue or PR by number. */
export async function addLabels(number: number, labels: string[]): Promise<void> {
  if (labels.length === 0) return;

  const args = [
    "issue",
    "edit",
    String(number),
    "--repo",
    REPO,
    ...labels.flatMap((l) => ["--add-label", l]),
  ];

  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return;
  }

  const { stdout, stderr, exitCode } = await runGh(args);
  if (exitCode !== 0) {
    throw new Error(`gh issue edit (labels) failed: ${stderr || stdout}`);
  }
}

/** Read an issue's title and body for a self-contained fixer prompt. */
export async function readIssue(number: number): Promise<IssueDetails | null> {
  if (isDryRun()) {
    console.log(`[DRY_RUN] gh issue view ${number} --repo ${REPO} --json title,body`);
    return null;
  }
  const { stdout, stderr, exitCode } = await runGh([
    "issue",
    "view",
    String(number),
    "--repo",
    REPO,
    "--json",
    "title,body",
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh issue view failed: ${stderr || stdout}`);
  }
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record["title"] === "string" && typeof record["body"] === "string"
    ? { title: record["title"], body: record["body"] }
    : null;
}

/** Comment on an issue. */
export async function commentIssue(number: number, body: string): Promise<void> {
  const args = [
    "issue",
    "comment",
    String(number),
    "--repo",
    REPO,
    "--body",
    body,
  ];
  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return;
  }
  const { stdout, stderr, exitCode } = await runGh(args);
  if (exitCode !== 0) {
    throw new Error(`gh issue comment failed: ${stderr || stdout}`);
  }
}

/** Atomically remove one issue label and add another. */
export async function replaceIssueLabel(
  number: number,
  remove: string,
  add: string,
): Promise<void> {
  const args = [
    "issue",
    "edit",
    String(number),
    "--repo",
    REPO,
    "--remove-label",
    remove,
    "--add-label",
    add,
  ];
  if (isDryRun()) {
    console.log(`[DRY_RUN] gh ${args.join(" ")}`);
    return;
  }
  const { stdout, stderr, exitCode } = await runGh(args);
  if (exitCode !== 0) {
    throw new Error(`gh issue edit (label swap) failed: ${stderr || stdout}`);
  }
}

export { FINGERPRINT_MARKER, REPO };

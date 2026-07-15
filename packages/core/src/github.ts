import {
  OUTCOME_FIXED_LABEL,
  OUTCOME_GAVE_UP_LABEL,
} from "./watch-fix";

const FINGERPRINT_MARKER = (hash: string) => `bug-loop:fingerprint:${hash}`;

/** Fixed metadata for labels we create lazily (never rewrite existing labels). */
export const LABEL_CREATE_META: Readonly<
  Record<string, { color: string; description: string }>
> = {
  [OUTCOME_FIXED_LABEL]: {
    color: "0e8a16",
    description: "bug-loop verified fix; PR opened",
  },
  [OUTCOME_GAVE_UP_LABEL]: {
    color: "d93f0b",
    description: "bug-loop fix loop gave up; needs human",
  },
};

const DEFAULT_LABEL_COLOR = "ededed";

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

export interface OpenIssue extends IssueRef {
  body: string;
  /** Label names currently on the issue (from `gh issue list --json labels`). */
  labels: string[];
}

export interface PRRef {
  number: number;
  url: string;
}

function isDryRun(): boolean {
  return process.env["DRY_RUN"] === "1" || process.env["DRY_RUN"] === "true";
}

export type GhCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GhRunner = (args: string[]) => Promise<GhCommandResult>;

async function runGh(args: string[]): Promise<GhCommandResult> {
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

/**
 * True when `gh label create` failed because the label already exists
 * (race or list cap miss). Treat as success so outcome-label edits still run.
 */
export function isLabelAlreadyExistsError(stderr: string, stdout = ""): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("already exists") ||
    text.includes("already_exists") ||
    text.includes("already been taken") ||
    text.includes("name has already been taken")
  );
}

/**
 * Lookup-or-create a label. Never uses `--force` (does not update existing
 * labels). Returns whether a create was issued.
 *
 * Existence is checked via a capped `gh label list` (limit 200). If the list
 * misses the label (cap/race) and create fails with already-exists, that is
 * treated as success so concurrent creators and large repos still proceed.
 */
export async function ensureLabelNonDestructive(input: {
  name: string;
  repo: string;
  dryRun: boolean;
  run: GhRunner;
  log?: (message: string) => void;
}): Promise<"dry-run" | "exists" | "created"> {
  const log = input.log ?? ((message: string) => console.log(message));
  if (input.dryRun) {
    log(`[DRY_RUN] gh label list --repo ${input.repo} --json name`);
    log(`[DRY_RUN] gh label create ${input.name} --repo ${input.repo} (if missing)`);
    return "dry-run";
  }
  const list = await input.run([
    "label", "list", "--repo", input.repo, "--json", "name", "--limit", "200",
  ]);
  if (list.exitCode !== 0) {
    throw new Error(`gh label list failed: ${list.stderr || list.stdout}`);
  }
  if (labelListIncludes(list.stdout, input.name)) return "exists";
  const args = buildLabelCreateArgs(input.name, input.repo);
  const created = await input.run(args);
  if (created.exitCode !== 0) {
    // Cap miss or concurrent create: label exists; do not block outcome edits.
    if (isLabelAlreadyExistsError(created.stderr, created.stdout)) {
      return "exists";
    }
    throw new Error(`gh label create failed: ${created.stderr || created.stdout}`);
  }
  return "created";
}

export class GitHubClient {
  constructor(readonly repo: string) {}

  async createIssue(input: IssueInput): Promise<IssueRef> {
    const args = ["issue", "create", "--repo", this.repo, "--title", input.title, "--body", input.body];
    for (const label of input.labels ?? []) args.push("--label", label);
    if (isDryRun()) {
      console.log(`[DRY_RUN] gh ${args.join(" ")}`);
      return { number: 9001, url: `https://github.com/${this.repo}/issues/9001` };
    }
    const { stdout, stderr, exitCode } = await runGh(args);
    if (exitCode !== 0) throw new Error(`gh issue create failed: ${stderr || stdout}`);
    const match = stdout.match(/\/issues\/(\d+)/);
    return { number: match?.[1] ? Number(match[1]) : 0, url: stdout };
  }

  async listOpenIssues(): Promise<OpenIssue[]> {
    if (isDryRun()) {
      console.log(`[DRY_RUN] gh issue list --repo ${this.repo} --state open`);
      return [];
    }
    const { stdout, stderr, exitCode } = await runGh([
      "issue", "list", "--repo", this.repo, "--state", "open",
      "--json", "number,url,body,labels",
      "--limit", "50",
    ]);
    if (exitCode !== 0) throw new Error(`gh issue list failed: ${stderr || stdout}`);
    interface GhLabel {
      name?: string;
    }
    interface GhIssue {
      number: number;
      url: string;
      body: string | null;
      labels?: Array<string | GhLabel> | null;
    }
    try {
      const issues = JSON.parse(stdout) as GhIssue[];
      return issues.map((issue) => ({
        number: issue.number,
        url: issue.url,
        body: issue.body ?? "",
        labels: parseLabelNames(issue.labels),
      }));
    } catch {
      return [];
    }
  }

  async findOpenIssueByMarker(hash: string): Promise<IssueRef | null> {
    return findOpenIssueByMarker(await this.listOpenIssues(), hash);
  }

  async createPullRequest(input: PRInput): Promise<PRRef> {
    const args = [
      "pr", "create", "--repo", this.repo, "--title", input.title, "--body", input.body,
      "--head", input.head, "--base", input.base ?? "main",
    ];
    for (const label of input.labels ?? []) args.push("--label", label);
    if (isDryRun()) {
      console.log(`[DRY_RUN] gh ${args.join(" ")}`);
      return { number: 9002, url: `https://github.com/${this.repo}/pull/9002` };
    }
    const { stdout, stderr, exitCode } = await runGh(args);
    if (exitCode !== 0) throw new Error(`gh pr create failed: ${stderr || stdout}`);
    const match = stdout.match(/\/pull\/(\d+)/);
    return { number: match?.[1] ? Number(match[1]) : 0, url: stdout };
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    // Outcome labels may not exist yet on the repo; create them lazily
    // (same pattern as other gh mutations: DRY_RUN prints and succeeds).
    for (const label of labels) {
      await this.ensureLabel(label);
    }
    await this.runMutation([
      "issue", "edit", String(number), "--repo", this.repo,
      ...labels.flatMap((label) => ["--add-label", label]),
    ], "gh issue edit (labels)");
  }

  async readIssue(number: number): Promise<IssueDetails | null> {
    const args = ["issue", "view", String(number), "--repo", this.repo, "--json", "title,body"];
    if (isDryRun()) {
      console.log(`[DRY_RUN] gh ${args.join(" ")}`);
      return null;
    }
    const { stdout, stderr, exitCode } = await runGh(args);
    if (exitCode !== 0) throw new Error(`gh issue view failed: ${stderr || stdout}`);
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return typeof record["title"] === "string" && typeof record["body"] === "string"
      ? { title: record["title"], body: record["body"] }
      : null;
  }

  async commentIssue(number: number, body: string): Promise<void> {
    await this.runMutation(
      ["issue", "comment", String(number), "--repo", this.repo, "--body", body],
      "gh issue comment",
    );
  }

  async replaceIssueLabel(number: number, remove: string, add: string): Promise<void> {
    await this.ensureLabel(add);
    await this.runMutation([
      "issue", "edit", String(number), "--repo", this.repo,
      "--remove-label", remove, "--add-label", add,
    ], "gh issue edit (label swap)");
  }

  /**
   * Create a label if missing. Lookup-or-create only — never `--force`, so
   * existing label color/description (e.g. needs-human) are never clobbered.
   * DRY_RUN-gated like all mutations.
   */
  async ensureLabel(name: string): Promise<void> {
    await ensureLabelNonDestructive({
      name,
      repo: this.repo,
      dryRun: isDryRun(),
      run: runGh,
    });
  }

  private async runMutation(args: string[], description: string): Promise<void> {
    if (isDryRun()) {
      console.log(`[DRY_RUN] gh ${args.join(" ")}`);
      return;
    }
    const { stdout, stderr, exitCode } = await runGh(args);
    if (exitCode !== 0) throw new Error(`${description} failed: ${stderr || stdout}`);
  }
}

function parseLabelNames(
  labels: Array<string | { name?: string }> | null | undefined,
): string[] {
  if (!labels) return [];
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      names.push(label);
      continue;
    }
    if (typeof label.name === "string") names.push(label.name);
  }
  return names;
}

/** Parse `gh label list --json name` stdout into label names. */
export function parseLabelListNames(stdout: string): string[] {
  if (!stdout.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    const names: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        names.push(item);
        continue;
      }
      if (typeof item === "object" && item !== null) {
        const name = (item as { name?: unknown }).name;
        if (typeof name === "string") names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** True when `gh label list --json name` output already includes `name`. */
export function labelListIncludes(stdout: string, name: string): boolean {
  return parseLabelListNames(stdout).includes(name);
}

/**
 * Args for `gh label create` without `--force`. Outcome labels get fixed
 * color/description; other labels get a neutral default color only.
 */
export function buildLabelCreateArgs(name: string, repo: string): string[] {
  const meta = LABEL_CREATE_META[name];
  const color = meta?.color ?? DEFAULT_LABEL_COLOR;
  const args = [
    "label", "create", name, "--repo", repo, "--color", color,
  ];
  if (meta?.description !== undefined) {
    args.push("--description", meta.description);
  }
  return args;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedWorktreeRoot(worktreeRoot: string): string {
  return worktreeRoot.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

export function toRepoRelativePath(filePath: string, worktreeRoot = ".worktrees"): string {
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (!normalized) return normalized;
  const root = normalizedWorktreeRoot(worktreeRoot);
  const worktreeMatch = root
    ? normalized.match(new RegExp(`(?:^|/)${escapeRegExp(root)}/[^/]+/(.+)$`))
    : null;
  if (worktreeMatch?.[1]) return worktreeMatch[1];
  if (normalized.startsWith("/")) {
    for (const root of ["apps/", "packages/", "pipelines/"] as const) {
      const index = normalized.indexOf(`/${root}`);
      if (index !== -1) return normalized.slice(index + 1);
    }
  }
  return normalized.replace(/^\.\//, "");
}

export function rewritePathsForPrBody(text: string, worktreeRoot = ".worktrees"): string {
  const root = normalizedWorktreeRoot(worktreeRoot);
  let out = text.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (full, _label: string, href: string) => {
      if (/^https?:\/\//i.test(href)) return full;
      if (!(href.startsWith("/") || (root && href.includes(`${root}/`)))) return full;
      return toRepoRelativePath(href, worktreeRoot);
    },
  );
  if (root) {
    const pathCharacter = "[^\\s)\\]`'\"]";
    const worktreePath = new RegExp(
      `/${pathCharacter}*?${escapeRegExp(root)}/${pathCharacter}+`,
      "g",
    );
    out = out.replace(worktreePath, (match) => toRepoRelativePath(match, worktreeRoot));
  }
  return out;
}

export function formatPrFilesList(
  filesChanged: string[],
  worktreeRoot = ".worktrees",
): string {
  if (filesChanged.length === 0) return "none recorded";
  return filesChanged.map((path) => toRepoRelativePath(path, worktreeRoot)).join(", ");
}

export { FINGERPRINT_MARKER };

export function findOpenIssueByMarker(
  issues: readonly OpenIssue[],
  hash: string,
): IssueRef | null {
  const marker = FINGERPRINT_MARKER(hash);
  const found = issues.find((issue) => issue.body.includes(marker));
  return found ? { number: found.number, url: found.url } : null;
}

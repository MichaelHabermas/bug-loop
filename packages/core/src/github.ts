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

export interface OpenIssue extends IssueRef {
  body: string;
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
      "issue", "list", "--repo", this.repo, "--state", "open", "--json", "number,url,body",
      "--limit", "50",
    ]);
    if (exitCode !== 0) throw new Error(`gh issue list failed: ${stderr || stdout}`);
    interface GhIssue {
      number: number;
      url: string;
      body: string | null;
    }
    try {
      const issues = JSON.parse(stdout) as GhIssue[];
      return issues.map((issue) => ({
        number: issue.number,
        url: issue.url,
        body: issue.body ?? "",
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
    await this.runMutation([
      "issue", "edit", String(number), "--repo", this.repo,
      "--remove-label", remove, "--add-label", add,
    ], "gh issue edit (label swap)");
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

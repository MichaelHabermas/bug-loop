/**
 * Detect issue bodies/comments that indicate a prior fix attempt already
 * finished (PR opened or give-up), so watch --fix must not re-enter workers.
 */
export function issueLooksFixResolved(body: string): boolean {
  return (
    body.includes("Fix verified and PR opened:") ||
    body.includes("Automated fix gave up after")
  );
}

/**
 * Whether a mechanical incident may enter the fix loop during a watch session.
 * Skips fingerprints already processed this session and issues that already
 * show a linked PR or give-up outcome.
 */
export function shouldEnterWatchFixLoop(input: {
  fingerprint: string;
  sessionProcessed: ReadonlySet<string>;
  openIssueBody?: string;
}): boolean {
  if (input.sessionProcessed.has(input.fingerprint)) return false;
  if (
    input.openIssueBody !== undefined &&
    issueLooksFixResolved(input.openIssueBody)
  ) {
    return false;
  }
  return true;
}

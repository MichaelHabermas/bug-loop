/**
 * Detect issue labels that indicate a prior fix attempt already finished
 * (PR opened or give-up), so --fix must not re-enter workers.
 *
 * Applies in one-shot and watch modes. Durable machine-readable labels are
 * applied on outcome so a later one-shot (or a restarted watch session with
 * an empty in-memory set) can still skip re-entry using data
 * listOpenIssues() already returns — including when self-generated repro log
 * lines remain pending after a cursor-not-EOF commit.
 */

/** Applied when a verified fix opens a PR. */
export const OUTCOME_FIXED_LABEL = "bug-loop:fixed";

/** Applied when the fix loop gives up (alongside needs-human). */
export const OUTCOME_GAVE_UP_LABEL = "bug-loop:gave-up";

export function issueLooksFixResolved(labels: readonly string[]): boolean {
  return (
    labels.includes(OUTCOME_FIXED_LABEL) ||
    labels.includes(OUTCOME_GAVE_UP_LABEL)
  );
}

/**
 * Whether a mechanical incident may enter the fix loop.
 * Skips fingerprints already processed this session (watch) and issues that
 * already carry a durable outcome label (one-shot and watch).
 */
export function shouldEnterWatchFixLoop(input: {
  fingerprint: string;
  sessionProcessed: ReadonlySet<string>;
  openIssueLabels?: readonly string[];
}): boolean {
  if (input.sessionProcessed.has(input.fingerprint)) return false;
  if (
    input.openIssueLabels !== undefined &&
    issueLooksFixResolved(input.openIssueLabels)
  ) {
    return false;
  }
  return true;
}

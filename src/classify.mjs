/**
 * Mechanical classes. Each function is pure: the same inputs give the same class, and the
 * class names the action. Nothing here asks a model.
 */

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASSED = new Set(["success", "skipped", "neutral"]);

/**
 * A branch is contained in the default branch when it has no commit the default branch lacks:
 * compare proves ahead_by === 0. A squash-merged PR head is NOT a proof
 * of commit containment; unique commits must not be deleted on that basis.
 */
export function branchClass({ branch, defaultBranch, ahead_by, openPullHeads, isProtected }) {
  if (branch.name === defaultBranch) return "default";
  if (isProtected) return "protected";
  if (openPullHeads.has(branch.name)) return "has-open-pull-request";
  if (ahead_by === 0) return "contained-in-default";
  return "unique-commits";
}

export const DELETABLE_BRANCH_CLASSES = new Set(["contained-in-default"]);

/** Check state of one head commit from its check runs and combined status. */
export function checksState({ checkRuns, status }) {
  const states = checkRuns.map((run) => (run.status !== "completed" ? "pending" : FAILED.has(run.conclusion) ? "failing" : PASSED.has(run.conclusion) ? "passing" : "failing"));
  if (status && status.total_count > 0) states.push(status.state === "success" ? "passing" : status.state === "pending" ? "pending" : "failing");
  if (states.includes("failing")) return "failing";
  if (states.includes("pending")) return "pending";
  return states.length ? "passing" : "none";
}

/**
 * One open pull request. `changedOnBase` is the set of paths the default branch changed since this
 * pull request's base commit; `files` the paths the pull request changes.
 */
export function pullClass({ pull, checks, files, changedOnBase, defaultBranch }) {
  if (pull.base.ref !== defaultBranch) return "not-against-default";
  if (pull.draft) return "draft";
  if (pull.mergeable === null || pull.mergeable === undefined) return "mergeability-unknown";
  if (files.length > 0 && files.every((file) => changedOnBase.has(file))) return "superseded-by-changes-on-default";
  if (pull.mergeable === false || pull.mergeable_state === "dirty") return "conflicting";
  if (checks === "failing") return "checks-failing";
  if (checks === "pending") return "checks-pending";
  if (checks === "none") return "no-checks";
  if (pull.mergeable_state !== "clean") return `not-clean-${pull.mergeable_state}`;
  return "green-and-mergeable";
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[:\s]+(?:([\w.-]+\/[\w.-]+)#|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|#)(\d+)/giu;

/** Issue numbers of `repo` that merged pull requests close by GitHub's closing keywords. */
export function issueClosers(mergedPulls, repo) {
  const closers = new Map();
  for (const pull of mergedPulls) {
    for (const match of `${pull.title}\n${pull.body ?? ""}`.matchAll(CLOSING)) {
      const target = match[1] ?? match[2] ?? repo;
      if (target.toLowerCase() === repo.toLowerCase() && !closers.has(Number(match[3]))) closers.set(Number(match[3]), pull);
    }
  }
  return closers;
}

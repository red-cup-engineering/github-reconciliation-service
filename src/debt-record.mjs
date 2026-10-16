const OWNING_SECTION = "computer-engineering-services-section";

const REPAIR = {
  "unique-commits": "Open a pull request for the commits or record them in the owning section; the branch holds work the default branch lacks.",
  conflicting: "Merge the default branch into the pull request head, resolve the conflicts, and push.",
  "checks-failing": "Read the failing check run, fix the cause in the pull request, and push.",
  "checks-pending": "Wait for the checks on the head commit; a check that never starts is a runner fault to record.",
  "no-checks": "No check ran on the head commit; run the repository's change test or add the workflow.",
  "superseded-by-changes-on-default": "Every file this pull request changes was changed on the default branch afterwards; confirm it is superseded and close it with a reason, or rebase.",
  "mergeability-unknown": "GitHub has not computed mergeability; the next pulse reads it again.",
  "not-against-default": "The pull request targets a branch other than the default; retarget or close it.",
};

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** A system-debt record in the register's existing shape, for one item no rule could settle. */
export function debtRecord({ repo, kind, id, cls, title, url, evidence, now }) {
  return {
    id: slug(`github-${repo}-${kind}-${id}-${cls}`),
    kind: "system-debt",
    system: repo,
    "owning-section": OWNING_SECTION,
    "breaks-requirements": [],
    evidence: `${kind} ${id}${title ? ` (${title})` : ""} in ${repo} is classed ${cls}. ${evidence ?? ""}`.trim() + (url ? ` ${url}` : ""),
    repair: REPAIR[cls] ?? "Decide whether to land, rebase or close it, and record the reason.",
    after: [],
    status: "open",
    "recorded-by": "github-reconciliation-service",
    "recorded-on": now.slice(0, 10),
  };
}

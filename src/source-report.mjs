/**
 * Source-owned admission of one complete, non-effectful GitHub reconciliation
 * observation. This is the ONE original provider/consumer type boundary: the
 * CLI validates its own generated result and the Computer Engineering Actions
 * reader imports this same function rather than copying Git ref, repository,
 * PR, issue, coverage or authority rules. JSON is a transient typed record,
 * not a second Work database or an authorization to merge/retire anything.
 *
 * GitHub full refs and immutable object IDs are source coordinates; provider
 * equality, Git ancestry and a completed census are not consumer receiving.
 */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/u;
const BRANCH_CLASSES = new Set(["contained-in-default", "unique-commits", "protected", "has-open-pull-request", "comparison-unavailable"]);
const LINEAGE = new Set(["diverged", "branch-ahead", "branch-behind", "identical", "not-observed"]);
const TAG_RELATIONS = new Set(["noncommit-or-unpeeled-ref", "same-base-commit", "source-history-contained-in-base", "source-history-ahead-of-base", "divergent-source-history"]);
const PULL_CLASSES = new Set([
  "green-and-mergeable","not-against-default","draft","mergeability-unknown",
  "conflicting","checks-unavailable","checks-failing","checks-pending",
  "no-checks","checks-inconclusive","same-files-changed-on-default",
  "base-difference-incomplete"
]);
const CHECK_STATES = new Set(["passing","failing","pending","none","inconclusive","unavailable"]);
const gitBranchRef = value => typeof value === "string" &&
  /^refs\/heads\/[A-Za-z0-9_][-A-Za-z0-9_./]*$/u.test(value) &&
  !/\.\.|@\{|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/u.test(value);
const positiveNumbers = values => Array.isArray(values) &&
  values.every((number,index) => Number.isSafeInteger(number) && number > 0 &&
    (index === 0 || values[index-1] < number));

function rows(report, field, kind, predicate) {
  const value = report[field];
  if (!Array.isArray(value) || value.some(item =>
    item === null || typeof item !== "object" || item.recordKind !== kind || !predicate(item)))
    throw new TypeError("missing or incompatible typed GitHub source: " + field);
  return value;
}

export function admitGitHubReconciliationSource(report,{repository}={}) {
  // A source contract must not silently re-admit the retired, unread
  // system-debt JSON family or the count that previously masqueraded as Work.
  if (report && (Object.hasOwn(report,"debtRecords") || Object.hasOwn(report,"debts")))
    throw new TypeError("retired system-debt JSON is not a GitHub source record");
  if (!REPO.test(repository ?? "") ||
      !report || report.applied !== false ||
      report.repositoriesObserved !== 1 || report.repositoriesFailed !== 0 ||
      report.archiveRefCoverage !== "complete-for-observed-repositories" ||
      report.sourceCutCoverage !== "matching-open-github-source-cuts" ||
      !Array.isArray(report.errors) || report.errors.length ||
      report.recordKind !== "github.reconciliation-source-report/v1")
    throw new TypeError("original GitHub source result is incomplete, effectful or out of scope");

  // A source observer must never be able to market a GitHub mutation as its
  // own completed receiving. Keep the native, separately authorized receiver.
  if (report.branchesDeleted !== 0 || report.pullRequestsMerged !== 0 ||
      report.issuesClosed !== 0 || report.branchesDeletable !== 0)
    throw new TypeError("source-only consumer received an effectful reconciliation result");

  const branchSources = rows(report, "branchSourceCandidates", "github.branch-source-reconciliation-candidate/v1",
    x => x.repositoryFullName === repository && Number.isSafeInteger(x.repositoryId) && x.repositoryId > 0 &&
      gitBranchRef(x.refName) &&
      positiveNumbers(x.matchingOpenPullRequestNumbers) &&
      positiveNumbers(x.unresolvedOpenPullRequestNumbers) &&
      !x.matchingOpenPullRequestNumbers.some(number=>x.unresolvedOpenPullRequestNumbers.includes(number)) &&
      OID.test(x.headCommitId ?? "") && BRANCH_CLASSES.has(x.technicalClassification) &&
      LINEAGE.has(x.sourceLineageRelation) &&
      x.automaticRefRetirementAllowed === false &&
      x.originalWorkReceiving === "not-observed" && x.ordinaryConsumerReceiving === "not-observed" &&
      Array.isArray(x.matchingArchiveRefNames));
  const pullSources = rows(report, "pullSourceCandidates", "github.pull-source-observation/v1",
    x => x.repositoryFullName === repository && Number.isSafeInteger(x.repositoryId) && x.repositoryId > 0 &&
      Number.isSafeInteger(x.pullRequestId) && x.pullRequestId > 0 &&
      Number.isSafeInteger(x.pullRequestNumber) && x.pullRequestNumber > 0 &&
      OID.test(x.sourceHeadCommitId ?? "") && OID.test(x.sourceBaseCommitId ?? "") &&
      gitBranchRef(x.sourceHeadRefName) && gitBranchRef(x.sourceBaseRefName) &&
      (x.sourceHeadRepositoryId === null ||
        (Number.isSafeInteger(x.sourceHeadRepositoryId) && x.sourceHeadRepositoryId > 0)) &&
      (x.sourceHeadRepositoryFullName === null || REPO.test(x.sourceHeadRepositoryFullName ?? "")) &&
      x.pullRequestState === "open" && typeof x.pullRequestUpdatedAt === "string" &&
      Number.isFinite(Date.parse(x.pullRequestUpdatedAt)) &&
      (PULL_CLASSES.has(x.technicalClassification) || /^not-clean-[a-z-]{1,32}$/u.test(x.technicalClassification ?? "")) &&
      CHECK_STATES.has(x.checkEvidenceState) &&
      ["complete","incomplete"].includes(x.baseDifferenceCoverage) &&
      Number.isSafeInteger(x.changedFileCount) && x.changedFileCount >= 0 &&
      x.sourceCoverage === "paged-current-open-github-pulls" &&
      x.automaticPullMergeAllowed === false &&
      x.originalWorkReceiving === "not-observed" && x.ordinaryConsumerReceiving === "not-observed");
  const archiveSources = rows(report, "archiveRefSources", "github.archive-ref-source-observation/v1",
    x => x.repository === repository && Number.isSafeInteger(x.repositoryId) && x.repositoryId > 0 &&
      typeof x.refName === "string" && x.refName.startsWith("refs/tags/archive/") &&
      OID.test(x.gitObjectId ?? "") && (x.peeledCommitId === null || OID.test(x.peeledCommitId ?? "")) &&
      TAG_RELATIONS.has(x.technicalRelation) && x.automaticRefRetirementAllowed === false &&
      x.independentReceivingRequired === true &&
      x.originalIssueReceiving === "not-observed" && x.originalConsumerReceiving === "not-observed");
  const issueSources = rows(report, "originalIssueSources", "github.issue-source-observation/v1",
    x => x.repositoryFullName === repository && Number.isSafeInteger(x.repositoryId) && x.repositoryId > 0 &&
      Number.isSafeInteger(x.issueId) && x.issueId > 0 &&
      Number.isSafeInteger(x.issueNumber) && x.issueNumber > 0 &&
      x.issueState === "open" && Number.isFinite(Date.parse(x.issueUpdatedAt)) &&
      x.automaticIssueClosureAllowed === false &&
      x.originalWorkReceiving === "not-observed" && x.ordinaryConsumerReceiving === "not-observed");

  // Recompute every BRANCH / open-PR relation from original admitted source.
  // Names alone, a branch called archive, and a green PR are never receipts.
  const originalPullRelation = (branch,pull) => {
    if (pull.sourceHeadRefName !== branch.refName) return null;
    const originId = pull.sourceHeadRepositoryId;
    if (originId !== null && originId !== branch.repositoryId) return null;
    if (originId === null && pull.sourceHeadRepositoryFullName !== null &&
        pull.sourceHeadRepositoryFullName.toLowerCase() !== repository.toLowerCase()) return null;
    return originId === branch.repositoryId && pull.sourceHeadCommitId === branch.headCommitId
      ? "matching" : "unresolved";
  };
  const contradictsPullRelations = branchSources.some(branch => {
    const matching = pullSources.filter(p => originalPullRelation(branch,p)==="matching")
      .map(p=>p.pullRequestNumber).sort((a,b)=>a-b);
    const unresolved = pullSources.filter(p => originalPullRelation(branch,p)==="unresolved")
      .map(p=>p.pullRequestNumber).sort((a,b)=>a-b);
    return JSON.stringify(matching) !== JSON.stringify(branch.matchingOpenPullRequestNumbers) ||
      JSON.stringify(unresolved) !== JSON.stringify(branch.unresolvedOpenPullRequestNumbers) ||
      (branch.technicalClassification === "has-open-pull-request" && matching.length === 0);
  });
  const identifiers = new Set([...branchSources, ...pullSources, ...archiveSources, ...issueSources].map(x => x.repositoryId));
  if (identifiers.size > 1 || contradictsPullRelations ||
      new Set(branchSources.map(x => x.refName)).size !== branchSources.length ||
      new Set(archiveSources.map(x => x.refName)).size !== archiveSources.length ||
      new Set(pullSources.map(x => x.pullRequestId)).size !== pullSources.length ||
      new Set(pullSources.map(x => x.pullRequestNumber)).size !== pullSources.length ||
      pullSources.some(x => issueSources.some(i => i.issueNumber === x.pullRequestNumber)) ||
      report.originalPullsObserved !== pullSources.length ||
      report.pullRequestsMergeable !== pullSources.filter(x => x.technicalClassification === "green-and-mergeable").length ||
      report.branchSourceCandidateCount !== branchSources.length ||
      new Set(issueSources.map(x => x.issueId)).size !== issueSources.length ||
      new Set(issueSources.map(x => x.issueNumber)).size !== issueSources.length ||
      branchSources.some(x => x.matchingArchiveRefNames.some(ref =>
        !archiveSources.some(t => t.refName === ref))) ||
      report.archiveTagSourcesObserved !== archiveSources.length ||
      report.originalIssuesObserved !== issueSources.length)
    throw new TypeError("contradictory original GitHub source identity, relationship or census counts");

  return Object.freeze({
    repository,
    branchSources:Object.freeze(branchSources),
    pullSources:Object.freeze(pullSources),
    archiveSources:Object.freeze(archiveSources),
    issueSources:Object.freeze(issueSources),
    sourceCoverage:"complete-observed-repository-only",
    originalWorkReceiving:"not-observed",
    ordinaryConsumerReceiving:"not-observed",
    effectsAuthorized:false,
  });
}

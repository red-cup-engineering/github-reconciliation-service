/**
 * One bounded, lossless-in-coordinates context index of the original GitHub
 * source report. No second inventory or Work ledger: each row is a selective
 * reading of an already-admitted original provider source, whose complete
 * report remains available from github-reconcile without --brief.
 *
 * A brief is not a claim that the original Work, ordinary consumer, or
 * historical Git sources have been settled. It cannot authorize effects.
 */
import { admitGitHubReconciliationSource } from "./source-report.mjs";

const by = (field) => (left, right) =>
  String(left[field]).localeCompare(String(right[field]), "en");

/**
 * Read a verified, complete ONE-repository GitHub source into a compact,
 * non-authorizing context frame. Source type admission is deliberately shared
 * with the normal Computer Engineering consumer.
 */
export function briefGitHubReconciliationSource(report, { repository } = {}) {
  const admitted = admitGitHubReconciliationSource(report, { repository });

  const issueSources = admitted.issueSources.map(issue => Object.freeze({
    issueNumber: issue.issueNumber,
    issueUpdatedAt: issue.issueUpdatedAt,
  })).sort((a, b) => a.issueNumber - b.issueNumber);

  const pullSources = admitted.pullSources.map(pull => Object.freeze({
    pullRequestNumber: pull.pullRequestNumber,
    sourceHeadCommitId: pull.sourceHeadCommitId,
    sourceBaseCommitId: pull.sourceBaseCommitId,
    sourceHeadRefName: pull.sourceHeadRefName,
    sourceHeadRepositoryId: pull.sourceHeadRepositoryId,
    technicalClassification: pull.technicalClassification,
    checkEvidenceState: pull.checkEvidenceState,
    baseDifferenceCoverage: pull.baseDifferenceCoverage,
  })).sort((a, b) => a.pullRequestNumber - b.pullRequestNumber);

  const branchSources = admitted.branchSources.map(branch => Object.freeze({
    refName: branch.refName,
    headCommitId: branch.headCommitId,
    sourceLineageRelation: branch.sourceLineageRelation,
    technicalClassification: branch.technicalClassification,
    aheadCommitCount: branch.aheadCommitCount,
    behindCommitCount: branch.behindCommitCount,
    matchingOpenPullRequestNumbers: branch.matchingOpenPullRequestNumbers,
    unresolvedOpenPullRequestNumbers: branch.unresolvedOpenPullRequestNumbers,
    matchingArchiveRefNames: branch.matchingArchiveRefNames,
  })).sort(by("refName"));

  const archiveRefSources = admitted.archiveSources.map(archive => Object.freeze({
    refName: archive.refName,
    gitObjectId: archive.gitObjectId,
    peeledCommitId: archive.peeledCommitId,
    technicalRelation: archive.technicalRelation,
  })).sort(by("refName"));

  return Object.freeze({
    recordKind: "github.reconciliation-source-brief/v1",
    repository: admitted.repository,
    sourceCoverage: admitted.sourceCoverage,
    originalWorkReceiving: "not-observed",
    ordinaryConsumerReceiving: "not-observed",
    effectsAuthorized: false,
    counts: Object.freeze({
      originalIssues: issueSources.length,
      originalPullRequests: pullSources.length,
      originalBranches: branchSources.length,
      originalArchiveRefs: archiveRefSources.length,
    }),
    issueSources: Object.freeze(issueSources),
    pullSources: Object.freeze(pullSources),
    branchSources: Object.freeze(branchSources),
    archiveRefSources: Object.freeze(archiveRefSources),
  });
}

/** Aggregate only independently admitted source frames, preserving failures.
 * An unobserved repository never disappears into a false complete census. */
export function briefGitHubSourceBatch({ expectedRepositories, frames, errors }) {
  if (!Number.isSafeInteger(expectedRepositories) || expectedRepositories < 1 ||
      !Array.isArray(frames) || !Array.isArray(errors) ||
      expectedRepositories !== frames.length + errors.length ||
      frames.some(frame => frame?.recordKind !== "github.reconciliation-source-brief/v1" ||
        frame.effectsAuthorized !== false || frame.sourceCoverage !== "complete-observed-repository-only") ||
      errors.some(error => typeof error?.repo !== "string" || !error.repo ||
        typeof error.error !== "string" || !error.error) ||
      new Set([...frames.map(frame => frame.repository), ...errors.map(error => error.repo)]).size !== expectedRepositories)
    throw new TypeError("GitHub source brief requires every requested repository, or an explicit failure");
  return Object.freeze({
    recordKind: "github.reconciliation-source-brief-batch/v1",
    sourceCutCoverage: errors.length === 0 ? "matching-open-github-source-cuts" : "incomplete",
    repositoriesObserved: frames.length,
    repositoriesFailed: errors.length,
    effectsAuthorized: false,
    frames: Object.freeze([...frames].sort(by("repository"))),
    errors: Object.freeze([...errors].sort(by("repo"))),
  });
}

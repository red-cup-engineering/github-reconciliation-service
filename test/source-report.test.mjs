import test from "node:test";
import assert from "node:assert/strict";
import { admitGitHubReconciliationSource as admit } from "../src/source-report.mjs";
import { briefGitHubReconciliationSource, briefGitHubSourceBatch } from "../src/source-brief.mjs";

// Exact original Computer Engineering consumer profile: the producer and
// actual reader must admit the SAME source-kind, Git refs and source counts.
const repository = "red-cup-engineering/computer-engineering-services-section";
const id = 1425262050;
const sha = suffix => suffix.repeat(40);
const revision = "2026-10-24T17:00:00Z";
function originalReport() {
  const refName = "refs/tags/archive/agent/unreceived";
  return {
    applied: false, repositoriesObserved: 1, repositoriesFailed: 0, errors: [],
    archiveRefCoverage: "complete-for-observed-repositories",
    sourceCutCoverage: "matching-open-github-source-cuts",
    branchesDeleted: 0, branchesDeletable: 0, issuesClosed: 0, pullRequestsMerged: 0,
    equivalentCandidates: 2, pullRequestsMergeable: 1, originalPullsObserved:1,
    branchSourceCandidateCount:1,
    archiveTagSourcesObserved: 1, originalIssuesObserved: 1,
    branchSourceCandidates: [{
      recordKind: "github.branch-source-reconciliation-candidate/v1",
      repositoryId: id, repositoryFullName: repository, refName: "refs/heads/codex/unreceived",
      headCommitId: sha("a"), technicalClassification: "unique-commits",
      sourceLineageRelation: "diverged", aheadCommitCount: 3, behindCommitCount: 2,
      matchingArchiveRefNames: [refName],
      matchingOpenPullRequestNumbers: [], unresolvedOpenPullRequestNumbers: [],
      automaticRefRetirementAllowed: false,
      originalWorkReceiving: "not-observed", ordinaryConsumerReceiving: "not-observed",
    }],
    pullSourceCandidates: [{
      recordKind:"github.pull-source-observation/v1",
      repositoryId:id,repositoryFullName:repository,pullRequestId:140519,pullRequestNumber:519,
      sourceHeadCommitId:sha("c"),sourceBaseCommitId:sha("d"),
      sourceHeadRepositoryId:id,sourceHeadRepositoryFullName:repository,
      sourceHeadRefName:"refs/heads/fix/receive",
      sourceBaseRefName:"refs/heads/main",pullRequestUpdatedAt:revision,
      pullRequestState:"open",technicalClassification:"green-and-mergeable",
      checkEvidenceState:"passing",baseDifferenceCoverage:"complete",
      changedFileCount:3,sourceCoverage:"paged-current-open-github-pulls",
      originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
      automaticPullMergeAllowed:false,
    }],
    archiveRefSources: [{
      recordKind: "github.archive-ref-source-observation/v1",
      repository, repositoryId: id, refName,
      gitObjectId: sha("b"), peeledCommitId: sha("a"),
      technicalRelation: "divergent-source-history",
      independentReceivingRequired: true, automaticRefRetirementAllowed: false,
      originalIssueReceiving: "not-observed", originalConsumerReceiving: "not-observed",
    }],
    originalIssueSources: [{
      recordKind: "github.issue-source-observation/v1",
      repositoryId: id, repositoryFullName: repository,
      issueId: 140277, issueNumber: 277, issueUpdatedAt: revision, issueState: "open",
      closingKeywordMergedPullRequestUrl: null, automaticIssueClosureAllowed: false,
      originalWorkReceiving: "not-observed", ordinaryConsumerReceiving: "not-observed",
    }],
  };
}

const profile=()=>({recordKind:"github.reconciliation-source-report/v1",...originalReport()});
const receive=report=>admit(report,{repository});

test("one original typed GitHub report is received as four distinct, read-only source families",()=>{
  const read=receive(profile());
  assert.equal(read.repository,repository);
  assert.equal(read.branchSources.length,1);
  assert.equal(read.pullSources.length,1);
  assert.equal(read.archiveSources.length,1);
  assert.equal(read.issueSources.length,1);
  assert.equal(read.effectsAuthorized,false);
  assert.equal(read.originalWorkReceiving,"not-observed");
  assert.equal(Object.hasOwn(profile(),"debtRecords"),false);
});

test("the same Work remains source in a fully observed empty GitHub repository",()=>{
  const report=profile();
  report.branchSourceCandidates=[];
  report.branchSourceCandidateCount=0;
  report.pullSourceCandidates=[];
  report.originalPullsObserved=0;
  report.pullRequestsMergeable=0;
  report.archiveRefSources=[];
  report.archiveTagSourcesObserved=0;
  report.originalIssueSources=[];
  report.originalIssuesObserved=0;
  const read=receive(report);
  assert.equal(read.branchSources.length+read.pullSources.length+
    read.archiveSources.length+read.issueSources.length,0);
  assert.equal(read.originalWorkReceiving,"not-observed");
});

test("same local PR head is a true source relation, not an authority grant",()=>{
  const report=profile(), branch=report.branchSourceCandidates[0],pr=report.pullSourceCandidates[0];
  pr.sourceHeadRefName=branch.refName;
  pr.sourceHeadCommitId=branch.headCommitId;
  branch.matchingOpenPullRequestNumbers=[519];
  branch.technicalClassification="has-open-pull-request";
  const read=receive(report);
  assert.deepEqual(read.branchSources[0].matchingOpenPullRequestNumbers,[519]);
  assert.equal(read.pullSources[0].automaticPullMergeAllowed,false);
});

test("foreign fork sharing a name and OID is independent source, not this branch",()=>{
  const report=profile(),branch=report.branchSourceCandidates[0],pr=report.pullSourceCandidates[0];
  pr.sourceHeadRepositoryId=9876;
  pr.sourceHeadRepositoryFullName="different/owner";
  pr.sourceHeadRefName=branch.refName;
  pr.sourceHeadCommitId=branch.headCommitId;
  assert.equal(receive(report).branchSources[0].matchingOpenPullRequestNumbers.length,0);
});

test("unknown originating PR repository preserves unresolved source rather than invented local identity",()=>{
  const report=profile(),branch=report.branchSourceCandidates[0],pr=report.pullSourceCandidates[0];
  pr.sourceHeadRepositoryId=null;
  pr.sourceHeadRepositoryFullName=null;
  pr.sourceHeadRefName=branch.refName;
  pr.sourceHeadCommitId=branch.headCommitId;
  branch.unresolvedOpenPullRequestNumbers=[519];
  assert.deepEqual(receive(report).branchSources[0].unresolvedOpenPullRequestNumbers,[519]);
});

test("all forged source identity, coverage, effects and relation claims refuse",()=>{
  for(const change of [
    r=>{delete r.recordKind;},
    r=>{r.debtRecords=1;},
    r=>{r.debts=[{kind:"system-debt"}];},
    r=>{r.recordKind="system-debt";},
    r=>{delete r.branchSourceCandidates;},
    r=>{r.branchSourceCandidateCount=0;},
    r=>{r.archiveRefSources=[];r.archiveTagSourcesObserved=0;},
    r=>{r.originalPullsObserved=0;},
    r=>{r.pullRequestsMergeable=0;},
    r=>{r.sourceCutCoverage="incomplete";},
    r=>{r.archiveRefCoverage="incomplete";},
    r=>{r.repositoriesObserved=0;},
    r=>{r.applied=true;},
    r=>{r.branchesDeleted=1;},
    r=>{r.pullSourceCandidates[0].automaticPullMergeAllowed=true;},
    r=>{r.branchSourceCandidates[0].automaticRefRetirementAllowed=true;},
    r=>{r.originalIssueSources[0].automaticIssueClosureAllowed=true;},
    r=>{r.branchSourceCandidates[0].matchingOpenPullRequestNumbers=[519];},
    r=>{r.branchSourceCandidates[0].unresolvedOpenPullRequestNumbers=[519];},
    r=>{r.pullSourceCandidates[0].sourceHeadRepositoryId="unknown";},
    r=>{r.pullSourceCandidates[0].sourceHeadRefName="refs/heads/../fake";},
    r=>{r.archiveRefSources[0].gitObjectId="not-a-git-oid";},
    r=>{r.originalIssueSources[0].issueUpdatedAt="not-a-revision";},
    r=>{r.originalIssueSources.push({...r.originalIssueSources[0]});r.originalIssuesObserved=2;},
  ]) {
    const report=profile();change(report);
    assert.throws(()=>receive(report));
  }
});

test("a named foreign repository cannot be disguised as the observed original scope",()=>{
  const report=profile();
  report.branchSourceCandidates[0].repositoryFullName="another/owner";
  assert.throws(()=>receive(report),/missing or incompatible/u);
});


test("an admitted compact source frame preserves all original GitHub source coordinates without treating them as Work", () => {
  const original = profile();
  const brief = briefGitHubReconciliationSource(original, { repository });
  assert.equal(brief.recordKind, "github.reconciliation-source-brief/v1");
  assert.deepEqual(brief.counts, {
    originalIssues: 1, originalPullRequests: 1, originalBranches: 1, originalArchiveRefs: 1,
  });
  assert.equal(brief.repository, repository);
  assert.equal(brief.issueSources[0].issueNumber, original.originalIssueSources[0].issueNumber);
  assert.equal(brief.pullSources[0].sourceHeadCommitId, original.pullSourceCandidates[0].sourceHeadCommitId);
  assert.equal(brief.pullSources[0].sourceHeadRefName, original.pullSourceCandidates[0].sourceHeadRefName);
  assert.equal(brief.branchSources[0].headCommitId, original.branchSourceCandidates[0].headCommitId);
  assert.equal(brief.branchSources[0].refName, original.branchSourceCandidates[0].refName);
  assert.equal(brief.archiveRefSources[0].gitObjectId, original.archiveRefSources[0].gitObjectId);
  assert.equal(brief.archiveRefSources[0].peeledCommitId, original.archiveRefSources[0].peeledCommitId);
  assert.equal(brief.effectsAuthorized, false);
  assert.equal(brief.originalWorkReceiving, "not-observed");
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < Buffer.byteLength(JSON.stringify(original)),
    "a context frame must be smaller than the full original report");
});

test("the compressed frame cannot launder forged GitHub relations, partial coverage, or Work authority", () => {
  for (const tamper of [
    source => { source.branchSourceCandidates[0].automaticRefRetirementAllowed = true; },
    source => { source.pullSourceCandidates[0].automaticPullMergeAllowed = true; },
    source => { source.archiveRefSources[0].gitObjectId = "not-a-real-object"; },
    source => { source.sourceCutCoverage = "incomplete"; },
    source => { source.branchSourceCandidateCount = 0; },
  ]) {
    const invalid = profile();
    tamper(invalid);
    assert.throws(() => briefGitHubReconciliationSource(invalid, { repository }));
  }
});

test("compact batch preserves incomplete repository coverage and refuses disappearing failures", () => {
  const frame = briefGitHubReconciliationSource(profile(), { repository });
  const complete = briefGitHubSourceBatch({ expectedRepositories: 1, frames: [frame], errors: [] });
  assert.equal(complete.sourceCutCoverage, "matching-open-github-source-cuts");
  const partial = briefGitHubSourceBatch({ expectedRepositories: 2, frames: [frame],
    errors: [{ repo: "other/repository", error: "GitHub source not readable" }] });
  assert.equal(partial.sourceCutCoverage, "incomplete");
  assert.equal(partial.repositoriesFailed, 1);
  assert.equal(partial.errors[0].repo, "other/repository");
  assert.throws(() => briefGitHubSourceBatch({ expectedRepositories: 2, frames: [frame], errors: [] }),
    /every requested repository/);
  assert.throws(() => briefGitHubSourceBatch({ expectedRepositories: 2, frames: [frame, frame], errors: [] }),
    /every requested repository/);
});

import { branchClass, checksState, SOURCE_CONTAINMENT_CLASSES, issueClosers, pullClass } from "./classify.mjs";
import { debtRecord } from "./debt-record.mjs";
import { assessEquivalentBranchSource } from "./receive-equivalent.mjs";
import { observeArchiveRefSources } from "./archive-ref-observation.mjs";

const path = (value) => value.split("/").map(encodeURIComponent).join("/");
const DAY = 86_400_000;

/** Repositories of the named organizations that are neither archived nor disabled. */
export async function listRepos(client, orgs) {
  const repos = [];
  for (const org of orgs) {
    for (const repo of await client.paginate(`/orgs/${org}/repos?type=all`, { maxPages: 20 })) {
      if (!repo.archived && !repo.disabled) repos.push(repo.full_name);
    }
  }
  return repos;
}

/**
 * Read one original GitHub repository's open Work/source and archive ref relations.
 * Source containment, checks, and closing keywords are evidence, not effect authority.
 * This public component has no write path; native GitHub Engineering handles exact
 * Work- and consumer-received integration and retirement. Nothing is archived.
 */
export async function reconcileRepo(client, repo, options = {}) {
  const { apply = false, mergeGreenPulls = false, receiveEquivalent = false, maxEquivalentMerges = 8, closeIssues = false, mergeMethod = "squash", maxMerges = 25, minAgeDays = 2, now = new Date().toISOString() } = options;
  // This public reader has no authenticated original Work/independent consumer
  // disposition. A parent workflow's GITHUB_TOKEN or generic --apply flag does
  // not grant ref retirement, issue closure or PR integration authority.
  if (apply) throw new TypeError("Original Work/consumer receiving required: use the native revision-bound GitHub Engineering integrator, not this source observer");
  const actions = [];
  const debts = [];
  const sourceCandidates = [];
  const pullSourceCandidates = [];
  const originalIssueSources = [];
  const note = (kind, target, extra = {}) => actions.push({ kind, repo, target, applied: false, ...extra });
  const old = (iso) => Date.parse(now) - Date.parse(iso) >= minAgeDays * DAY;

  const info = await client.request("GET", `/repos/${repo}`);
  const defaultBranch = info.default_branch;
  if (!Number.isSafeInteger(info.id) || info.id <= 0 || !defaultBranch)
    throw new TypeError("source owner repository ID and default branch not observed");
  const [branches, openPulls, closedPulls, openIssues] = await Promise.all([
    client.paginate(`/repos/${repo}/branches`),
    client.paginate(`/repos/${repo}/pulls?state=open`),
    client.paginate(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, { maxPages: 3 }),
    client.paginate(`/repos/${repo}/issues?state=open`),
  ]);
  const mergedPulls = closedPulls.filter((pull) => pull.merged_at);
  // An issue is a first-class original Work/source candidate even when no
  // merged PR uses a closing keyword. This is one already-observed GitHub
  // source list, not a new issue queue or fabricated outcome.
  const closers = issueClosers(mergedPulls, repo);
  const seenIssueIds = new Set(), seenIssueNumbers = new Set();
  for (const issue of openIssues) {
    if (issue.pull_request) continue;
    if (!Number.isSafeInteger(issue.id) || issue.id < 1 ||
        !Number.isSafeInteger(issue.number) || issue.number < 1 ||
        seenIssueIds.has(issue.id) || seenIssueNumbers.has(issue.number) ||
        issue.state !== "open" || typeof issue.updated_at !== "string" ||
        !Number.isFinite(Date.parse(issue.updated_at)))
      throw new TypeError("Original GitHub issue identity, revision or source coverage is incomplete");
    seenIssueIds.add(issue.id);seenIssueNumbers.add(issue.number);
    const closer = closers.get(issue.number) ?? null;
    originalIssueSources.push(Object.freeze({
      recordKind: "github.issue-source-observation/v1",
      repositoryId: info.id, repositoryFullName: repo,
      issueId: issue.id, issueNumber: issue.number,
      issueUpdatedAt: issue.updated_at, issueState: "open",
      closingKeywordMergedPullRequestUrl: closer?.html_url ?? null,
      sourceCoverage: "paged-current-open-github-issues",
      originalWorkReceiving: "not-observed",
      ordinaryConsumerReceiving: "not-observed",
      automaticIssueClosureAllowed: false,
      firstReceivingAction: closer
        ? "reconcile-merged-source-with-original-issue-need-and-beneficiary"
        : "read-original-issue-requirement-and-ordinary-consumer",
    }));
  }

  // Every open pull request is original source, including draft, contested,
  // non-default-target and unread CI cases. A green subset is NOT the inventory.
  const seenPullIds = new Set(), seenPullNumbers = new Set();
  for (const summary of openPulls) {
    const pull = await client.request("GET", `/repos/${repo}/pulls/${summary.number}`);
    const files = (await client.paginate(`/repos/${repo}/pulls/${pull.number}/files`)).map((file) => file.filename);
    const compare = await client.request("GET", `/repos/${repo}/compare/${pull.base.sha}...${path(defaultBranch)}`);
    // GitHub caps compare files at 300. Do not treat an incomplete base
    // difference as an observed safe or superseded source review.
    const comparisonComplete = Array.isArray(compare?.files)
      && compare.files.length<300 && compare.too_large!==true;
    const changedOnBase = new Set(comparisonComplete
      ?compare.files.map(file=>file.filename):[]);
    const [runsRead, statusRead] = await Promise.allSettled([
      client.paginate(`/repos/${repo}/commits/${pull.head.sha}/check-runs`),
      client.request("GET", `/repos/${repo}/commits/${pull.head.sha}/status`),
    ]);
    // Successful observation of either source is not evidence that the
    // OTHER source is empty. Refuse a green verdict on partial CI visibility.
    const checks = runsRead.status === "fulfilled" && Array.isArray(runsRead.value) &&
      statusRead.status === "fulfilled" && Number.isSafeInteger(statusRead.value?.total_count) &&
      typeof statusRead.value?.state === "string"
      ? checksState({ checkRuns: runsRead.value, status: statusRead.value })
      : "unavailable";
    const provisional = pullClass({ pull, checks, files, changedOnBase, defaultBranch });
    const cls=!comparisonComplete&&provisional==="green-and-mergeable"
      ?"base-difference-incomplete":provisional;
    if (!Number.isSafeInteger(pull.id) || pull.id <= 0 ||
        !Number.isSafeInteger(pull.number) || pull.number <= 0 ||
        pull.number !== summary.number || pull.state !== "open" ||
        seenPullIds.has(pull.id) || seenPullNumbers.has(pull.number) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pull.head?.sha ?? "") ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pull.base?.sha ?? "") ||
        typeof pull.head?.ref !== "string" || !pull.head.ref ||
        typeof pull.base?.ref !== "string" || !pull.base.ref ||
        typeof pull.updated_at !== "string" ||
        !Number.isFinite(Date.parse(pull.updated_at)) ||
        (summary.head?.sha !== undefined && summary.head.sha !== pull.head.sha) ||
        (summary.id !== undefined && summary.id !== pull.id) ||
        (pull.head.repo?.id !== undefined &&
          (!Number.isSafeInteger(pull.head.repo.id) || pull.head.repo.id <= 0)) ||
        (pull.head.repo?.full_name !== undefined &&
          (typeof pull.head.repo.full_name !== "string" || !pull.head.repo.full_name)))
      throw new TypeError("Original GitHub pull request identity, revision or source coverage is incomplete");
    seenPullIds.add(pull.id); seenPullNumbers.add(pull.number);
    pullSourceCandidates.push(Object.freeze({
      recordKind:"github.pull-source-observation/v1",
      repositoryId:info.id,repositoryFullName:repo,
      pullRequestId:pull.id,pullRequestNumber:pull.number,
      sourceHeadCommitId:pull.head.sha,sourceBaseCommitId:pull.base.sha,
      // GitHub numeric repository identity outlives transfers/renames.
      // A nullable source origin is UNKNOWN, never locally owned by guess.
      sourceHeadRepositoryId:pull.head.repo?.id ?? null,
      sourceHeadRepositoryFullName:pull.head.repo?.full_name ?? null,
      sourceHeadRefName:"refs/heads/"+pull.head.ref,
      sourceBaseRefName:"refs/heads/"+pull.base.ref,
      pullRequestUpdatedAt:pull.updated_at,pullRequestState:"open",
      technicalClassification:cls,checkEvidenceState:checks,
      baseDifferenceCoverage:comparisonComplete?"complete":"incomplete",
      changedFileCount:files.length,
      sourceCoverage:"paged-current-open-github-pulls",
      originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
      automaticPullMergeAllowed:false,
      firstReceivingAction:"read-original-proposal-requirements-exact-source-and-ordinary-consumer",
    }));
    // The observer has no merge actuator. A historical mutation limit must
    // never hide genuine PR source candidates from Work receiving.
    if (cls === "green-and-mergeable") {
      const action = { kind: "receive-pull-source", repo, target: pull.number, class: cls,
        recordKind:"github.pull-source-review-candidate/v1",sourceHeadCommitId:pull.head.sha,
        sourceBaseCommitId:pull.base.sha, applied:false,title:pull.title,
        originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
        mergeAuthority:"not-granted-by-observer" };
      // An assessed pull request does not author or merge its source.
      actions.push(action);
    } else if (cls !== "draft" && cls !== "mergeability-unknown" && old(pull.updated_at)) {
      debts.push(debtRecord({ repo, kind: "pull-request", id: pull.number, cls, title: pull.title, url: pull.html_url, now,
        ...(cls === "checks-unavailable"
          ? { evidence: "GitHub check runs or commit statuses could not be fully observed; no green merge qualification." }
          : cls === "base-difference-incomplete"
          ? { evidence: "GitHub returned an incomplete original base difference; neither nonconflict nor supersession was established." }
          : cls === "same-files-changed-on-default"
          ? { evidence: "Only filenames overlap; the original behavior and ordinary consumer are not yet reconciled." }
          : {}) }));
    }
  }

  // A short PR branch name alone is not a Git relation. Correlate original
  // pull source ONLY by exact named ref, immutable head OID and stable numeric
  // originating repository identity. Unknown origin or changed head is a
  // separate unresolved reading. A known fork with the same ref never
  // masquerades as this repository's branch or authorizes ref effects.
  function openPullRelationFor(branch) {
    const refName="refs/heads/"+branch.name;
    const exact=[],unresolved=[];
    for(const pull of pullSourceCandidates) {
      if(pull.sourceHeadRefName!==refName)continue;
      const originId=pull.sourceHeadRepositoryId;
      if(originId!==null && originId!==info.id)continue; // known other repository
      if(originId===null && pull.sourceHeadRepositoryFullName!==null &&
        pull.sourceHeadRepositoryFullName.toLowerCase()!==repo.toLowerCase())continue; // named fork
      if(originId===info.id && pull.sourceHeadCommitId===branch.commit?.sha)
        exact.push(pull.pullRequestNumber);
      else
        unresolved.push(pull.pullRequestNumber); // no source ID, or changed head
    }
    return Object.freeze({
      matchingOpenPullRequestNumbers:Object.freeze(exact.sort((a,b)=>a-b)),
      unresolvedOpenPullRequestNumbers:Object.freeze(unresolved.sort((a,b)=>a-b)),
    });
  }
  const originalDefaultHead=branches.find(branch=>branch.name===defaultBranch)?.commit?.sha;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(originalDefaultHead ?? ""))
    throw new TypeError("observed default source is required before tag or branch action");
  // The original Git Services source observer owns actual Git semantics;
  // this GitHub REST adapter only preserves true ref/tag object identity.
  // An archive-named tag is NOT an archive receipt or supersession decision.
  const sourceObservations = await observeArchiveRefSources(client,{
    repository:repo,repositoryId:info.id,observedBaseCommitId:originalDefaultHead,
    observedBaseRefName:"refs/heads/"+defaultBranch,
  });
  const tagCommitHeads = new Set(sourceObservations.map(x=>x.peeledCommitId).filter(Boolean));
  for(const observed of sourceObservations){
    note("receive-archive-tag-source",observed.refName,{
      refObjectId:observed.gitObjectId,
      peeledCommitId:observed.peeledCommitId,
      technicalRelation:observed.technicalRelation,
      sourceRecordKind:observed.recordKind,
      independentConsumerReceivingRequired:true,
      nextOwner:observed.nextOwner,
    });
  }
  let equivalentReceipts=0;
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const compare = await client.request("GET", `/repos/${repo}/compare/${path(defaultBranch)}...${path(branch.name)}`).catch(() => null);
    const pullRelation=openPullRelationFor(branch);
    const openPullHeads=new Set(pullRelation.matchingOpenPullRequestNumbers.length?[branch.name]:[]);
    const cls = branchClass({ branch, defaultBranch, ahead_by: compare?.ahead_by ?? null, openPullHeads, isProtected: branch.protected });
    const aheadCommitCount=Number.isSafeInteger(compare?.ahead_by)&&compare.ahead_by>=0?compare.ahead_by:null;
    const behindCommitCount=Number.isSafeInteger(compare?.behind_by)&&compare.behind_by>=0?compare.behind_by:null;
    const mergeBaseCommitId=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(compare?.merge_base_commit?.sha??"")
      ?compare.merge_base_commit.sha:null;
    const sourceLineageRelation=aheadCommitCount===null||behindCommitCount===null||mergeBaseCommitId===null
      ?"not-observed":aheadCommitCount>0&&behindCommitCount>0?"diverged"
      :aheadCommitCount>0?"branch-ahead":behindCommitCount>0?"branch-behind":"identical";
    // Every non-default branch is original code source, including protected
    // heads, heads with open PRs and unavailable comparisons. Only the class
    // differs; no technical observation establishes receiving or retirement.
    sourceCandidates.push(Object.freeze({
        recordKind:"github.branch-source-reconciliation-candidate/v1",
        repositoryId:info.id,repositoryFullName:repo,refName:"refs/heads/"+branch.name,
        headCommitId:branch.commit?.sha??null,
        defaultBranchName:defaultBranch,observedDefaultCommitId:originalDefaultHead,
        technicalClassification:cls,aheadCommitCount,behindCommitCount,
        mergeBaseCommitId,sourceLineageRelation,
        ...pullRelation,
        matchingArchiveRefNames:Object.freeze(sourceObservations.filter(x=>
          x.peeledCommitId!==null&&x.peeledCommitId===branch.commit?.sha)
          .map(x=>x.refName).sort()),
        originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
        automaticRefRetirementAllowed:false,
        firstReceivingAction:"reconcile-source-requirements-issues-and-ordinary-consumer-at-native-github-owner"
      }));
    if (SOURCE_CONTAINMENT_CLASSES.has(cls)) {
      const action = { kind: "receive-contained-branch-source", repo, target: branch.name,
        recordKind:"github.branch-source-reconciliation-candidate/v1",
        class:cls,applied:false,refRetirementAllowed:false,
        originalWorkReceiving:"not-observed" };
      // A retained archive-named tag referencing the same commit is evidence
      // of a still-open original source and issue/consumer custody question.
      // Even a contained commit is NOT consent to retire the branch's name.
      if(tagCommitHeads.has(branch.commit?.sha)){
        action.reason="archive-tag-source-awaits-original-work-and-consumer-receiving";
        action.refRetirementAllowed=false;
        debts.push(debtRecord({repo,kind:"branch",id:branch.name,
          cls:"archive-ref-source-not-received",now,
          evidence:"Same commit remains under an archive-named tag; source, original issue and installed consumer acceptance have not been independently received."}));
        actions.push(action);
        continue;
      }
      actions.push(action);
    } else if (cls === "unique-commits") {
      // Distinct commits are NEVER deleted outright. With an explicit
      // receiving mode, prove that every changed file/Gitlink already exists
      // on main, then receive the historical commits through a real Git merge
      // and retire the source branch. This is not semantic equivalence of
      // claims or permission to merge arbitrary unqualified PRs.
      if (receiveEquivalent && !branch.protected && originalDefaultHead &&
          Number.isSafeInteger(maxEquivalentMerges) &&
          equivalentReceipts < maxEquivalentMerges) {
        const receipt=await assessEquivalentBranchSource(client,{
          repo,base:defaultBranch,branch:branch.name,headSha:branch.commit.sha,
          baseSha:originalDefaultHead,compare,apply,
        });
        if (receipt.fileCount>0) {
          equivalentReceipts++;
          actions.push({
            kind:"assess-equivalent-branch-source",repo,target:branch.name,
            class:"source-byte-equivalent",applied:false,effectPermitted:false,
            automaticRefRetirementAllowed:false,
            originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
            firstReceivingAction:"receive-distinct-source-history-and-ordinary-consumer-at-native-owner",
            verifiedFiles:receipt.fileCount,reason:receipt.reason,
          });
          // A proven byte identity is not a received Git history or operating result.
          continue;
        }
      }
      const head = await client.request("GET", `/repos/${repo}/commits/${branch.commit.sha}`).catch(() => null);
      const date = head?.commit?.committer?.date;
      if (date && old(date)) debts.push(debtRecord({ repo, kind: "branch", id: branch.name, cls, evidence: `${compare?.ahead_by ?? "?"} commits not in ${defaultBranch}; last commit ${date}.`, now }));
    }
  }

  if (closers.size) {
    for (const issue of openIssues) {
      const pull = closers.get(issue.number);
      if (!pull || issue.pull_request) continue;
      const action = { kind: "receive-issue-outcome", repo, target: issue.number,
        recordKind:"github.issue-outcome-receiving-candidate/v1",
        class:"named-by-merged-pull-request",applied:false,by:pull.html_url,
        originalWorkReceiving:"not-observed",independentBeneficiaryReceiving:"not-observed",
        automaticClosureAllowed:false };
      // A GitHub closing keyword cannot close original Work.
      actions.push(action);
    }
  }
  return { repo, actions, debts, sourceObservations,
    sourceCandidates:Object.freeze(sourceCandidates),
    pullSourceCandidates:Object.freeze(pullSourceCandidates),
    originalIssueSources:Object.freeze(originalIssueSources),
    originalWorkReceiving:"not-observed",effectAuthority:"none; native Work receiving required" };
}

export function summarize(results) {
  const count = (kind) => results.flatMap((result) => result.actions).filter((action) => action.kind === kind);
  return {
    repos: results.length,
    branchesDeleted:0, equivalentHistoryReceived:0,equivalentHistoryRetired:0,
    equivalentCandidates:count("assess-equivalent-branch-source").length,
    branchesDeletable:0,
    branchSourceCandidateCount:results.reduce((n,r)=>n+(r.sourceCandidates?.length??0),0),
    originalPullsObserved:results.reduce((n,r)=>n+(r.pullSourceCandidates?.length??0),0),
    pullRequestsMerged:0,pullRequestsMergeable:count("receive-pull-source").length,
    issuesClosed:0,issuesClosable:0,
    issueOutcomeCandidates:count("receive-issue-outcome").length,
    originalIssuesObserved:results.reduce((count,result)=>
      count+(result.originalIssueSources?.length??0),0),
    archiveTagSourcesObserved: results.reduce((total,result)=>total+(result.sourceObservations?.length ?? 0),0),
    archiveTagSourcesAwaitingReceiving: results.reduce((total,result)=>total+(result.sourceObservations?.filter(x=>x.independentReceivingRequired).length ?? 0),0),
    branchesHeldByArchiveSource:results.reduce((n,r)=>n+(r.sourceCandidates?.filter(
      x=>x.matchingArchiveRefNames.length).length??0),0),
    debtRecords: results.reduce((total, result) => total + result.debts.length, 0),
  };
}

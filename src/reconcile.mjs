import { branchClass, checksState, DELETABLE_BRANCH_CLASSES, issueClosers, pullClass } from "./classify.mjs";
import { debtRecord } from "./debt-record.mjs";
import { receiveEquivalentBranch } from "./receive-equivalent.mjs";
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
 * Reconcile one repository. Reads are always made. Writes (delete a contained branch, merge a green
 * pull request, close an issue a merged pull request fixed) are made only with `apply`; every other
 * item becomes a debt record. Nothing is archived and no repository is deleted.
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
  const note = (kind, target, extra = {}) => actions.push({ kind, repo, target, applied: false, ...extra });
  const old = (iso) => Date.parse(now) - Date.parse(iso) >= minAgeDays * DAY;

  const info = await client.request("GET", `/repos/${repo}`);
  const defaultBranch = info.default_branch;
  if (!Number.isSafeInteger(info.id) || info.id <= 0 || !defaultBranch)
    throw new TypeError("source owner repository ID and default branch not observed");
  const [branches, openPulls, closedPulls] = await Promise.all([
    client.paginate(`/repos/${repo}/branches`),
    client.paginate(`/repos/${repo}/pulls?state=open`),
    client.paginate(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, { maxPages: 3 }),
  ]);
  const mergedPulls = closedPulls.filter((pull) => pull.merged_at);

  // Pull requests first, so a merge can make its branch contained in the same pulse.
  let merges = 0;
  for (const summary of openPulls) {
    const pull = await client.request("GET", `/repos/${repo}/pulls/${summary.number}`);
    const files = (await client.paginate(`/repos/${repo}/pulls/${pull.number}/files`)).map((file) => file.filename);
    const compare = await client.request("GET", `/repos/${repo}/compare/${pull.base.sha}...${path(defaultBranch)}`);
    const changedOnBase = new Set((compare.files ?? []).map((file) => file.filename));
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
    const cls = pullClass({ pull, checks, files, changedOnBase, defaultBranch });
    if (cls === "green-and-mergeable" && merges < maxMerges) {
      merges += 1;
      const action = { kind: "receive-pull-source", repo, target: pull.number, class: cls,
        recordKind:"github.pull-source-review-candidate/v1",sourceHeadCommitId:pull.head.sha,
        sourceBaseCommitId:pull.base.sha, applied:false,title:pull.title,
        originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
        mergeAuthority:"not-granted-by-observer" };
      if (apply && mergeGreenPulls) {
        // Authorization is explicit; an attempted merge is not a completed
        // merge. Read back the exact provider outcome before concluding the
        // PR is merged or allowing its closing keywords to close Work.
        try {
          const receipt = await client.request("PUT", `/repos/${repo}/pulls/${pull.number}/merge`,
            { merge_method: mergeMethod, sha: pull.head.sha });
          if (receipt?.merged !== true || !/^[a-f0-9]{40}$/u.test(receipt.sha ?? ""))
            throw new TypeError("GitHub returned no confirmed merge SHA");
          action.providerAcknowledged = true;
          action.mergeSha = receipt.sha;
          const accepted = await client.request("GET", `/repos/${repo}/pulls/${pull.number}`);
          if (accepted?.number !== pull.number || accepted?.state !== "closed" ||
              accepted?.merged !== true || !accepted.merged_at ||
              accepted.merge_commit_sha !== receipt.sha ||
              accepted.base?.ref !== defaultBranch)
            throw new TypeError("merged PR readback disagrees with provider merge receipt");
          action.applied = true;
          mergedPulls.push(accepted);
        } catch (error) {
          debts.push(debtRecord({ repo, kind: "pull-request", id: pull.number,
            cls: "merge-receipt-unverified", title: pull.title, url: pull.html_url, now,
            evidence: "Merge requested but its independently read-back state is unknown or contradictory; do not infer closure or retry blindly. " +
              error.message }));
        }
      }
      actions.push(action);
    } else if (cls !== "draft" && cls !== "mergeability-unknown" && old(pull.updated_at)) {
      debts.push(debtRecord({ repo, kind: "pull-request", id: pull.number, cls, title: pull.title, url: pull.html_url, now,
        ...(cls === "checks-unavailable"
          ? { evidence: "GitHub check runs or commit statuses could not be fully observed; no green merge qualification." }
          : {}) }));
    }
  }

  // A fork PR can have the same short head ref as an unrelated local
  // branch. Unknown origin remains conservative; known forks cannot
  // indefinitely obstruct safe contained local branch retirement.
  const openPullHeads = new Set(openPulls
    .filter((pull) => !pull.head?.repo?.full_name ||
      pull.head.repo.full_name.toLowerCase() === repo.toLowerCase())
    .map((pull) => pull.head?.ref));
  const originalDefaultHead=branches.find(branch=>branch.name===defaultBranch)?.commit?.sha;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(originalDefaultHead ?? ""))
    throw new TypeError("observed default source is required before tag or branch action");
  // The original Git Services source observer owns actual Git semantics;
  // this GitHub REST adapter only preserves true ref/tag object identity.
  // An archive-named tag is NOT an archive receipt or supersession decision.
  const sourceObservations = await observeArchiveRefSources(client,{
    repository:repo,repositoryId:info.id,observedBaseCommitId:originalDefaultHead,
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
    const cls = branchClass({ branch, defaultBranch, ahead_by: compare?.ahead_by ?? null, openPullHeads, isProtected: branch.protected });
    const aheadCommitCount=Number.isSafeInteger(compare?.ahead_by)&&compare.ahead_by>=0?compare.ahead_by:null;
    const behindCommitCount=Number.isSafeInteger(compare?.behind_by)&&compare.behind_by>=0?compare.behind_by:null;
    const mergeBaseCommitId=/^[a-f0-9]{40}$/u.test(compare?.merge_base_commit?.sha??"")
      ?compare.merge_base_commit.sha:null;
    const sourceLineageRelation=aheadCommitCount===null||behindCommitCount===null||mergeBaseCommitId===null
      ?"not-observed":aheadCommitCount>0&&behindCommitCount>0?"diverged"
      :aheadCommitCount>0?"branch-ahead":behindCommitCount>0?"branch-behind":"identical";
    if(["contained-in-default","unique-commits"].includes(cls))
      sourceCandidates.push(Object.freeze({
        recordKind:"github.branch-source-reconciliation-candidate/v1",
        repositoryId:info.id,repositoryFullName:repo,refName:"refs/heads/"+branch.name,
        headCommitId:branch.commit?.sha??null,
        defaultBranchName:defaultBranch,observedDefaultCommitId:originalDefaultHead,
        technicalClassification:cls,aheadCommitCount,behindCommitCount,
        mergeBaseCommitId,sourceLineageRelation,
        matchingArchiveRefNames:Object.freeze(sourceObservations.filter(x=>
          x.peeledCommitId!==null&&x.peeledCommitId===branch.commit?.sha)
          .map(x=>x.refName).sort()),
        originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
        automaticRefRetirementAllowed:false,
        firstReceivingAction:"reconcile-source-requirements-issues-and-ordinary-consumer-at-native-github-owner"
      }));
    if (DELETABLE_BRANCH_CLASSES.has(cls)) {
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
      if (apply) {
        let head, branchNow, latest, openNow;
        try {
          [head, branchNow, latest, openNow] = await Promise.all([
            client.request("GET", `/repos/${repo}/git/ref/heads/${path(branch.name)}`),
            client.request("GET", `/repos/${repo}/branches/${path(branch.name)}`),
            client.request("GET", `/repos/${repo}/compare/${path(defaultBranch)}...${path(branch.name)}`),
            client.paginate(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split("/")[0] + ":" + branch.name)}`),
          ]);
        } catch (error) {
          debts.push(debtRecord({ repo, kind:"branch", id:branch.name,
            cls:"changed-during-reconciliation", now,
            evidence:"Pre-delete verification unavailable; ref left intact: "+error.message }));
          actions.push(action);
          continue;
        }
        if (head.object?.sha !== branch.commit.sha ||
            branchNow.commit?.sha !== branch.commit.sha ||
            branchNow.protected !== false || latest.ahead_by !== 0 ||
            !Array.isArray(openNow) || openNow.length !== 0) {
          debts.push(debtRecord({ repo, kind:"branch", id:branch.name,
            cls:"changed-during-reconciliation", now,
            evidence:"Head, protection, open PRs, or containment changed; ref left intact." }));
        } else {
          await client.request("DELETE", `/repos/${repo}/git/refs/heads/${path(branch.name)}`);
          action.applied = true;
        }
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
        const receipt=await receiveEquivalentBranch(client,{
          repo,base:defaultBranch,branch:branch.name,headSha:branch.commit.sha,
          baseSha:originalDefaultHead,compare,apply,
        });
        if (receipt.fileCount>0) {
          equivalentReceipts++;
          actions.push({
            kind:"assess-equivalent-branch-source",repo,target:branch.name,
            class:"content-equivalent",applied:receipt.received,
            deleted:receipt.deleted,prNumber:receipt.prNumber??null,
            verifiedFiles:receipt.fileCount,reason:receipt.reason,
          });
          if (apply && (!receipt.received || !receipt.deleted))
            debts.push(debtRecord({repo,kind:"branch",id:branch.name,
              cls:"equivalent-receiving-blocked",now,
              evidence:"Equivalent history was not fully received and retired: "+
                receipt.reason+(receipt.detail?" "+receipt.detail:"")+
                (receipt.closeProblem?"; PR close failed: "+receipt.closeProblem:"")}));
          continue;
        }
      }
      const head = await client.request("GET", `/repos/${repo}/commits/${branch.commit.sha}`).catch(() => null);
      const date = head?.commit?.committer?.date;
      if (date && old(date)) debts.push(debtRecord({ repo, kind: "branch", id: branch.name, cls, evidence: `${compare?.ahead_by ?? "?"} commits not in ${defaultBranch}; last commit ${date}.`, now }));
    }
  }

  const closers = issueClosers(mergedPulls, repo);
  if (closers.size) {
    for (const issue of await client.paginate(`/repos/${repo}/issues?state=open`)) {
      const pull = closers.get(issue.number);
      if (!pull || issue.pull_request) continue;
      const action = { kind: "receive-issue-outcome", repo, target: issue.number,
        recordKind:"github.issue-outcome-receiving-candidate/v1",
        class:"named-by-merged-pull-request",applied:false,by:pull.html_url,
        originalWorkReceiving:"not-observed",independentBeneficiaryReceiving:"not-observed",
        automaticClosureAllowed:false };
      if (apply) {
        // A completed HTTP request is not a provider-observed issue state.
        // Retain an unconfirmed closure as debt; never repeat a write blindly.
        try{
          await client.request("POST", `/repos/${repo}/issues/${issue.number}/comments`,
            { body: `Closed because ${pull.html_url} merged and states that it fixes this issue.` });
          await client.request("PATCH", `/repos/${repo}/issues/${issue.number}`,
            { state: "closed", state_reason: "completed" });
          const readback=await client.request("GET",`/repos/${repo}/issues/${issue.number}`);
          if(readback?.number!==issue.number || readback?.state!=="closed" ||
             readback?.state_reason!=="completed" || Boolean(readback?.pull_request))
            throw new TypeError("GitHub issue closure readback was not independently received");
          action.applied=true;
          action.providerIssueState="closed";
          action.originalWorkReceived=false; // GitHub issue status does not grant original Work closure.
        }catch(error){
          action.reason="issue-closure-readback-unverified";
          debts.push(debtRecord({repo,kind:"issue",id:issue.number,
            cls:"issue-closure-readback-unverified",now,
            evidence:"GitHub issue closure attempted but the exact provider state is unknown or contradicted. Independently reconcile before retry."}));
        }
      }
      actions.push(action);
    }
  }
  return { repo, actions, debts, sourceObservations,
    sourceCandidates:Object.freeze(sourceCandidates),
    originalWorkReceiving:"not-observed",effectAuthority:"none; native Work receiving required" };
}

export function summarize(results) {
  const count = (kind) => results.flatMap((result) => result.actions).filter((action) => action.kind === kind);
  return {
    repos: results.length,
    branchesDeleted:0, equivalentHistoryReceived:0,equivalentHistoryRetired:0,
    equivalentCandidates:count("assess-equivalent-branch-source").length,
    branchesDeletable:0,
    branchSourceCandidates:results.reduce((n,r)=>n+(r.sourceCandidates?.length??0),0),
    pullRequestsMerged:0,pullRequestsMergeable:count("receive-pull-source").length,
    issuesClosed:0,issuesClosable:0,
    issueOutcomeCandidates:count("receive-issue-outcome").length,
    archiveTagSourcesObserved: results.reduce((total,result)=>total+(result.sourceObservations?.length ?? 0),0),
    archiveTagSourcesAwaitingReceiving: results.reduce((total,result)=>total+(result.sourceObservations?.filter(x=>x.independentReceivingRequired).length ?? 0),0),
    branchesHeldByArchiveSource:results.reduce((n,r)=>n+(r.sourceCandidates?.filter(
      x=>x.matchingArchiveRefNames.length).length??0),0),
    debtRecords: results.reduce((total, result) => total + result.debts.length, 0),
  };
}

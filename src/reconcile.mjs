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
  const actions = [];
  const debts = [];
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
      const action = { kind: "merge-pull-request", repo, target: pull.number, class: cls, applied: false, title: pull.title };
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
    if (DELETABLE_BRANCH_CLASSES.has(cls)) {
      const action = { kind: "delete-branch", repo, target: branch.name, class: cls, applied: false };
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
            kind:"receive-equivalent-branch",repo,target:branch.name,
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
  if (closeIssues && closers.size) {
    for (const issue of await client.paginate(`/repos/${repo}/issues?state=open`)) {
      const pull = closers.get(issue.number);
      if (!pull || issue.pull_request) continue;
      const action = { kind: "close-issue", repo, target: issue.number, class: "fixed-by-merged-pull-request", applied: false, by: pull.html_url };
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
  return { repo, actions, debts, sourceObservations };
}

export function summarize(results) {
  const count = (kind) => results.flatMap((result) => result.actions).filter((action) => action.kind === kind);
  return {
    repos: results.length,
    branchesDeleted: count("delete-branch").filter((action) => action.applied).length+
      count("receive-equivalent-branch").filter((action)=>action.deleted).length,
    equivalentHistoryReceived:count("receive-equivalent-branch").filter((action)=>action.applied).length,
    equivalentHistoryRetired:count("receive-equivalent-branch").filter((action)=>action.deleted).length,
    equivalentCandidates:count("receive-equivalent-branch").length,
    branchesDeletable: count("delete-branch").length,
    pullRequestsMerged: count("merge-pull-request").filter((action) => action.applied).length,
    pullRequestsMergeable: count("merge-pull-request").length,
    issuesClosed: count("close-issue").filter((action) => action.applied).length,
    issuesClosable: count("close-issue").length,
    archiveTagSourcesObserved: results.reduce((total,result)=>total+(result.sourceObservations?.length ?? 0),0),
    archiveTagSourcesAwaitingReceiving: results.reduce((total,result)=>total+(result.sourceObservations?.filter(x=>x.independentReceivingRequired).length ?? 0),0),
    branchesHeldByArchiveSource: count("delete-branch").filter(x=>x.refRetirementAllowed===false).length,
    debtRecords: results.reduce((total, result) => total + result.debts.length, 0),
  };
}

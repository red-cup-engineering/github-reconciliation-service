import { branchClass, checksState, DELETABLE_BRANCH_CLASSES, issueClosers, pullClass } from "./classify.mjs";
import { debtRecord } from "./debt-record.mjs";

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
  const { apply = false, closeIssues = false, mergeMethod = "squash", maxMerges = 25, minAgeDays = 2, now = new Date().toISOString() } = options;
  const actions = [];
  const debts = [];
  const note = (kind, target, extra = {}) => actions.push({ kind, repo, target, applied: false, ...extra });
  const old = (iso) => Date.parse(now) - Date.parse(iso) >= minAgeDays * DAY;

  const info = await client.request("GET", `/repos/${repo}`);
  const defaultBranch = info.default_branch;
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
    const [checkRuns, status] = await Promise.all([
      client.paginate(`/repos/${repo}/commits/${pull.head.sha}/check-runs`).catch(() => []),
      client.request("GET", `/repos/${repo}/commits/${pull.head.sha}/status`).catch(() => null),
    ]);
    const cls = pullClass({ pull, checks: checksState({ checkRuns, status }), files, changedOnBase, defaultBranch });
    if (cls === "green-and-mergeable" && merges < maxMerges) {
      merges += 1;
      const action = { kind: "merge-pull-request", repo, target: pull.number, class: cls, applied: false, title: pull.title };
      if (apply) {
        await client.request("PUT", `/repos/${repo}/pulls/${pull.number}/merge`, { merge_method: mergeMethod, sha: pull.head.sha });
        action.applied = true;
        mergedPulls.push({ ...pull, merged_at: now });
      }
      actions.push(action);
    } else if (cls !== "draft" && cls !== "mergeability-unknown" && old(pull.updated_at)) {
      debts.push(debtRecord({ repo, kind: "pull-request", id: pull.number, cls, title: pull.title, url: pull.html_url, now }));
    }
  }

  const openPullHeads = new Set(openPulls.map((pull) => pull.head.ref));
  for (const branch of branches) {
    if (branch.name === defaultBranch) continue;
    const compare = await client.request("GET", `/repos/${repo}/compare/${path(defaultBranch)}...${path(branch.name)}`).catch(() => null);
    const cls = branchClass({ branch, defaultBranch, ahead_by: compare?.ahead_by ?? null, openPullHeads, isProtected: branch.protected });
    if (DELETABLE_BRANCH_CLASSES.has(cls)) {
      const action = { kind: "delete-branch", repo, target: branch.name, class: cls, applied: false };
      if (apply) {
        const head = await client.request("GET", `/repos/${repo}/git/ref/heads/${path(branch.name)}`);
        const latest = await client.request("GET", `/repos/${repo}/compare/${path(defaultBranch)}...${path(branch.name)}`);
        if (head.object?.sha !== branch.commit.sha || latest.ahead_by !== 0) {
          debts.push(debtRecord({ repo, kind: "branch", id: branch.name,
            cls: "changed-during-reconciliation", now,
            evidence: "Head or containment changed before deletion. Ref left intact." }));
        } else {
          await client.request("DELETE", `/repos/${repo}/git/refs/heads/${path(branch.name)}`);
          action.applied = true;
        }
      }
      actions.push(action);
    } else if (cls === "unique-commits") {
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
        await client.request("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: `Closed because ${pull.html_url} merged and states that it fixes this issue.` });
        await client.request("PATCH", `/repos/${repo}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
        action.applied = true;
      }
      actions.push(action);
    }
  }
  return { repo, actions, debts };
}

export function summarize(results) {
  const count = (kind) => results.flatMap((result) => result.actions).filter((action) => action.kind === kind);
  return {
    repos: results.length,
    branchesDeleted: count("delete-branch").filter((action) => action.applied).length,
    branchesDeletable: count("delete-branch").length,
    pullRequestsMerged: count("merge-pull-request").filter((action) => action.applied).length,
    pullRequestsMergeable: count("merge-pull-request").length,
    issuesClosed: count("close-issue").filter((action) => action.applied).length,
    issuesClosable: count("close-issue").length,
    debtRecords: results.reduce((total, result) => total + result.debts.length, 0),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {SOURCE_CONTAINMENT_CLASSES, DELETABLE_BRANCH_CLASSES} from "../src/classify.mjs";
import { branchClass, checksState, issueClosers, pullClass } from "../src/classify.mjs";
import { reconcileRepo, summarize } from "../src/reconcile.mjs";
import { createClient } from "../src/github-client.mjs";

const NOW = "2026-10-15T12:00:00Z";
const OLD = "2026-10-01T00:00:00Z";

test("checksState reads check runs and the combined status", () => {
  const run = (status, conclusion) => ({ status, conclusion });
  assert.equal(checksState({ checkRuns: [run("completed", "success"), run("completed", "skipped")], status: null }), "passing");
  assert.equal(checksState({ checkRuns: [run("completed", "success"), run("in_progress")], status: null }), "pending");
  assert.equal(checksState({ checkRuns: [run("completed", "failure")], status: null }), "failing");
  assert.equal(checksState({ checkRuns: [run("completed", "skipped")], status:null }), "inconclusive");
  assert.equal(checksState({ checkRuns: [run("completed", "neutral")], status:null }), "inconclusive");
  assert.equal(checksState({ checkRuns: [run("completed", "skipped"),run("completed","neutral")], status:null }), "inconclusive");
  assert.equal(checksState({ checkRuns: [], status: { total_count: 0, state: "pending" } }), "none");
  assert.equal(checksState({ checkRuns: [], status: { total_count: 1, state: "failure" } }), "failing");
});

test("branchClass separates ancestry from receiving and unknown comparisons", () => {
  const base = { defaultBranch: "main", mergedHeadShas: new Set(["abc"]), openPullHeads: new Set(["open"]), isProtected: false, ahead_by: 3 };
  const branch = (name, sha = "zzz") => ({ name, commit: { sha } });
  assert.equal(branchClass({ ...base, branch: branch("main") }), "default");
  assert.equal(branchClass({ ...base, branch: branch("open"), ahead_by: 0 }), "has-open-pull-request");
  assert.equal(branchClass({ ...base, branch: branch("x"), ahead_by: 0 }), "contained-in-default");
  assert.equal(branchClass({ ...base, branch: branch("squashed", "abc") }), "unique-commits");
  assert.equal(branchClass({ ...base, branch: branch("work") }), "unique-commits");
  assert.equal(branchClass({ ...base, branch: branch("lost"), ahead_by: null }), "comparison-unavailable");
  assert.equal(branchClass({ ...base, branch: branch("lost"), ahead_by: -1 }), "comparison-unavailable");
  assert.equal(branchClass({ ...base, branch: branch("rel"), isProtected: true, ahead_by: 0 }), "protected");
});

test("pullClass prioritizes real source refusals over ambiguous same-file names", () => {
  const pull = (over = {}) => ({ base: { ref: "main" }, draft: false, mergeable: true, mergeable_state: "clean", ...over });
  const args = (over = {}, extra = {}) => ({ pull: pull(over), checks: "passing", files: ["a"], changedOnBase: new Set(), defaultBranch: "main", ...extra });
  assert.equal(pullClass(args()), "green-and-mergeable");
  assert.equal(pullClass(args({ draft: true })), "draft");
  assert.equal(pullClass(args({ mergeable: null })), "mergeability-unknown");
  assert.equal(pullClass(args({}, { changedOnBase: new Set(["a", "b"]) })), "same-files-changed-on-default");
  assert.equal(pullClass(args({ mergeable:false,mergeable_state:"dirty" }, { changedOnBase:new Set(["a"]) })), "conflicting");
  assert.equal(pullClass(args({}, { checks:"failing",changedOnBase:new Set(["a"]) })), "checks-failing");
  assert.equal(pullClass(args({}, { checks:"inconclusive",changedOnBase:new Set(["a"]) })), "checks-inconclusive");
  assert.equal(pullClass(args({ mergeable: false, mergeable_state: "dirty" })), "conflicting");
  assert.equal(pullClass(args({}, { checks: "failing" })), "checks-failing");
  assert.equal(pullClass(args({}, { checks: "none" })), "no-checks");
  assert.equal(pullClass(args({}, { checks: "unavailable" })), "checks-unavailable");
  assert.equal(pullClass(args({ mergeable_state: "blocked" })), "not-clean-blocked");
  assert.equal(pullClass(args({ base: { ref: "dev" } })), "not-against-default");
});

test("issueClosers needs a closing keyword and a number with #, in this repository only", () => {
  const closers = issueClosers([
    { number: 1, title: "Fix 3 bugs", body: "fixes #7 and closes o/r#8, resolves other/repo#9, closed https://github.com/o/r/issues/10" },
    { number: 2, title: "Refs #11", body: "mentions #12" },
  ], "o/r");
  assert.deepEqual([...closers.keys()].sort((a, b) => a - b), [7, 8, 10]);
});

/** A fake GitHub keyed by "METHOD path"; records every write. */
function fake(routes) {
  const writes = [];
  const merged = new Set();
  const closedIssues = new Set();
  const MERGE_SHA = "a".repeat(40);
  const client = {
    async request(method, path, body) {
      if (method !== "GET") {
        writes.push({ method, path, body });
        if (method === "PUT" && /\/pulls\/\d+\/merge$/u.test(path)) {
          const response = routes[`MERGE ${path}`] ?? { merged: true, sha: MERGE_SHA };
          if (response?.merged === true) merged.add(Number(path.match(/\/pulls\/(\d+)\/merge$/u)[1]));
          return response;
        }
        if (method==="PATCH" && /\/issues\/\d+$/u.test(path) && body?.state==="closed")
          closedIssues.add(Number(path.match(/\/issues\/(\d+)$/u)[1]));
        return null;
      }
      if (path === "/repos/o/r/issues/40" && closedIssues.has(40)) {
        if (routes["ISSUE READBACK /repos/o/r/issues/40"] === false)
          throw new Error("post-close provider read is unavailable");
        return routes["ISSUE READBACK /repos/o/r/issues/40"] ??
          {number:40,state:"closed",state_reason:"completed"};
      }
      if (path === "/repos/o/r/pulls/5" && merged.has(5) &&
          routes["MERGED READBACK /repos/o/r/pulls/5"] !== false) {
        return { ...routes["GET /repos/o/r/pulls/5"], state: "closed", merged: true,
          merged_at: NOW, merge_commit_sha: MERGE_SHA };
      }
      const hit = Object.entries(routes).find(([key]) => key === `GET ${path}`);
      if (!hit) throw Object.assign(new Error(`no route ${path}`), { status: 404 });
      return hit[1];
    },
    async paginate(path) {
      const hit = routes[`LIST ${path}`];
      if (!hit) throw new Error(`no list ${path}`);
      return hit;
    },
  };
  return { client, writes };
}

const repo = "o/r";
const world = () => ({
  "GET /repos/o/r": { id: 12345, default_branch: "main" },
  "LIST /repos/o/r/branches": [
    { name: "main", protected: false, commit: { sha: "a".repeat(40) } },
    { name: "done", protected: false, commit: { sha: "d" } },
    { name: "squashed", protected: false, commit: { sha: "s1" } },
    { name: "work", protected: false, commit: { sha: "w" } },
    { name: "pr-green", protected: false, commit: { sha: "g1" } },
  ],
  "GET /repos/o/r/git/matching-refs/tags/archive/": [],
  "GET /repos/o/r/git/ref/heads/main": {ref:"refs/heads/main",object:{type:"commit",sha:"a".repeat(40)}},
  "LIST /repos/o/r/pulls?state=open": [
    { number: 5, head: { ref: "pr-green", sha: "g1" } },
    { number: 6, head: { ref: "pr-red", sha: "r1" } },
  ],
  "LIST /repos/o/r/pulls?state=closed&sort=updated&direction=desc": [
    { number: 3, merged_at: OLD, head: { sha: "s1" }, title: "Carry the thing", body: "Fixes #40", html_url: "u3" },
    { number: 4, merged_at: null, head: { sha: "x" }, title: "closed unmerged", body: "fixes #41" },
  ],
  "GET /repos/o/r/pulls/5": { number: 5, title: "green", base: { ref: "main", sha: "b" }, head: { ref: "pr-green", sha: "g1" }, draft: false, mergeable: true, mergeable_state: "clean", updated_at: OLD, html_url: "u5" },
  "GET /repos/o/r/pulls/6": { number: 6, title: "red", base: { ref: "main", sha: "b" }, head: { ref: "pr-red", sha: "r1" }, draft: false, mergeable: false, mergeable_state: "dirty", updated_at: OLD, html_url: "u6" },
  "LIST /repos/o/r/pulls/5/files": [{ filename: "a.txt" }],
  "LIST /repos/o/r/pulls/6/files": [{ filename: "b.txt" }],
  "GET /repos/o/r/compare/b...main": { files: [{ filename: "z.txt" }] },
  "LIST /repos/o/r/commits/g1/check-runs": [{ status: "completed", conclusion: "success" }],
  "LIST /repos/o/r/commits/r1/check-runs": [],
  "GET /repos/o/r/commits/g1/status": { total_count: 0, state: "pending" },
  "GET /repos/o/r/commits/r1/status": { total_count: 0, state: "pending" },
  "GET /repos/o/r/compare/main...done": { ahead_by: 0 },
  "GET /repos/o/r/git/ref/heads/done": { object: { sha: "d" } },
  "GET /repos/o/r/branches/done": { commit: { sha: "d" }, protected: false },
  "LIST /repos/o/r/pulls?state=open&head=o%3Adone": [],
  "GET /repos/o/r/compare/main...squashed": { ahead_by: 2 },
  "GET /repos/o/r/compare/main...work": { ahead_by: 4 },
  "GET /repos/o/r/compare/main...pr-green": { ahead_by: 1 },
  "GET /repos/o/r/commits/w": { commit: { committer: { date: OLD } } },
  "LIST /repos/o/r/issues?state=open": [
    { id: 140, number: 40, state:"open", updated_at:OLD },
    { id: 141, number: 41, state:"open", updated_at:OLD },
    { id: 142, number: 42, state:"open", updated_at:OLD },
    { id: 143, number: 43, pull_request: {}, state:"open", updated_at:OLD },
  ],
});

test("original source read reports branch, issue and PR receiving candidates without effects",async()=>{
 const {client,writes}=fake(world());
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 assert.deepEqual(result.actions.map(a=>a.kind+":"+a.target+":"+a.applied).sort(),[
  "receive-contained-branch-source:done:false",
  "receive-issue-outcome:40:false",
  "receive-pull-source:5:false"
 ]);
 assert.equal(result.effectAuthority,"none; native Work receiving required");
 assert.equal(result.sourceCandidates.length,4);
 assert.ok(result.sourceCandidates.every(c=>
  c.recordKind==="github.branch-source-reconciliation-candidate/v1"
  &&c.automaticRefRetirementAllowed===false
  &&c.originalWorkReceiving==="not-observed"));
 assert.equal(result.sourceCandidates[0].refName,"refs/heads/done");
  const heldByPr=result.sourceCandidates.find(c=>c.refName==="refs/heads/pr-green");
  assert.equal(heldByPr.technicalClassification,"has-open-pull-request");
  assert.equal(heldByPr.automaticRefRetirementAllowed,false);
  assert.equal(heldByPr.originalWorkReceiving,"not-observed");
});

test("historical apply cannot merge, close or delete; refused before original provider reads",async()=>{
 const calls=[];
 const client={request:async()=>{calls.push("request");throw Error("no provider access");},
 paginate:async()=>{calls.push("paginate");throw Error("no provider access");}};
 for(const options of [
  {apply:true},
  {apply:true,mergeGreenPulls:true,closeIssues:true},
  {apply:true,receiveEquivalent:true,maxEquivalentMerges:3}
 ]){
  await assert.rejects(reconcileRepo(client,repo,{...options,now:NOW}),
    /original Work\/consumer receiving required|Original Work\/consumer receiving required/i);
 }
 assert.deepEqual(calls,[],"a generic --apply never authorizes even provider reads");
 const {client:observer,writes}=fake(world());
 const read=await reconcileRepo(observer,repo,{now:NOW,mergeGreenPulls:true,closeIssues:true});
 assert.deepEqual(writes,[]);
 assert.equal(summarize([read]).branchesDeleted,0);
 assert.equal(summarize([read]).pullRequestsMerged,0);
 assert.equal(summarize([read]).issuesClosed,0);
 assert.equal(summarize([read]).branchSourceCandidates,4);
 assert.equal(summarize([read]).issueOutcomeCandidates,1);
});

test("closing-keyword discovery is always an unresolved original Work candidate",async()=>{
 const {client,writes}=fake(world());
 const result=await reconcileRepo(client,repo,{closeIssues:true,now:NOW});
 assert.deepEqual(writes,[]);
 assert.ok(result.actions.some(a=>a.kind==="receive-issue-outcome"
   &&a.target===40&&a.automaticClosureAllowed===false
   &&a.originalWorkReceiving==="not-observed"));
 assert.equal(result.sourceCandidates.find(x=>x.refName==="refs/heads/squashed").technicalClassification,
   "unique-commits");
});

test("a source-contained branch remains held even if no open PR has been observed",async()=>{
 const {client,writes}=fake(world());
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.ok(result.actions.some(a=>a.kind==="receive-contained-branch-source"
   &&a.target==="done"&&a.refRetirementAllowed===false));
 assert.deepEqual(writes,[],"lack of open PR is not original content acceptance");
});

test("an observed protected or changed source cannot acquire retirement authority",async()=>{
 for(const edited of [
   {"LIST /repos/o/r/branches":[
     {name:"main",commit:{sha:"a".repeat(40)}},
     {name:"done",protected:true,commit:{sha:"d"}}
   ]},
   {"GET /repos/o/r/compare/main...done":{ahead_by:1,behind_by:12,
      merge_base_commit:{sha:"f".repeat(40)}}}
 ]){
   const {client,writes}=fake({...world(),...edited});
   const result=await reconcileRepo(client,repo,{now:NOW});
   assert.deepEqual(writes,[]);
   assert.ok(!result.actions.some(a=>a.applied));
    const held=result.sourceCandidates.find(c=>c.refName==="refs/heads/done");
    assert.ok(held,"protected and held branch source must still be reported");
    assert.equal(held.automaticRefRetirementAllowed,false);
 }
});

test("ahead branch is source needing reconciliation, never deletion permission",async()=>{
 const {client,writes}=fake({...world(),
  "GET /repos/o/r/compare/main...done":{ahead_by:1,behind_by:2,
    merge_base_commit:{sha:"f".repeat(40)}}});
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 const c=result.sourceCandidates.find(x=>x.refName==="refs/heads/done");
 assert.equal(c.sourceLineageRelation,"diverged");
 assert.equal(c.automaticRefRetirementAllowed,false);
 assert.equal(c.aheadCommitCount,1);
 assert.equal(c.behindCommitCount,2);
});

test("unread source comparison remains unknown, not a forced ref mutation",async()=>{
 const routes=world();
 delete routes["GET /repos/o/r/compare/main...done"];
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 const candidate=result.sourceCandidates.find(x=>x.refName==="refs/heads/done");
 assert.equal(candidate.sourceLineageRelation,"not-observed");
 assert.equal(candidate.technicalClassification,"comparison-unavailable");
 assert.equal(candidate.aheadCommitCount,null);
 assert.equal(candidate.automaticRefRetirementAllowed,false);
});

test("SHA-256 merge-base identities survive branch source observation without Work acceptance",async()=>{
 const routes=world(),mergeBase="f".repeat(64);
 routes["GET /repos/o/r/compare/main...done"]={ahead_by:2,behind_by:3,
   merge_base_commit:{sha:mergeBase}};
 const {client,writes}=fake(routes);
 const read=await reconcileRepo(client,repo,{now:NOW});
 const source=read.sourceCandidates.find(row=>row.refName==="refs/heads/done");
 assert.equal(source.mergeBaseCommitId,mergeBase);
 assert.equal(source.sourceLineageRelation,"diverged");
 assert.equal(source.originalWorkReceiving,"not-observed");
 assert.equal(source.automaticRefRetirementAllowed,false);
 assert.deepEqual(writes,[]);
});

test("original equivalence source reader is useful but not a native content receiver",async()=>{
 const routes=world();
 routes["GET /repos/o/r/contents/src/a.mjs?ref=main"]={sha:"sha1",type:"file"};
 routes["GET /repos/o/r/contents/src/a.mjs?ref=squashed"]={sha:"sha1",type:"file"};
 routes["GET /repos/o/r/compare/main...squashed"]={
  ahead_by:2,files:[{filename:"src/a.mjs",status:"modified"}]};
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{
   receiveEquivalent:true,now:NOW,maxEquivalentMerges:1});
 const assessment=result.actions.filter(a=>a.kind==="assess-equivalent-branch-source");
 assert.equal(assessment.length,1);
 assert.equal(assessment[0].target,"squashed");
 assert.equal(assessment[0].verifiedFiles,1);
 assert.equal(assessment[0].applied,false);
 assert.equal(assessment[0].automaticRefRetirementAllowed,false);
 assert.equal(assessment[0].effectPermitted,false);
 assert.equal(assessment[0].ordinaryConsumerReceiving,"not-observed");
 assert.deepEqual(writes,[]);
 assert.equal(summarize([result]).equivalentCandidates,1);
 assert.equal(summarize([result]).equivalentHistoryRetired,0);
});

test("legacy merge flags without Work admission remain source-only",async()=>{
 const {client,writes}=fake(world());
 const result=await reconcileRepo(client,repo,{maxMerges:0,mergeGreenPulls:true,now:NOW});
 assert.deepEqual(writes,[]);
 assert.equal(summarize([result]).pullRequestsMerged,0);
 assert.equal(summarize([result]).pullRequestsMergeable,1,
   "historical zero merge limit must not censor source-only PR reviews");
 assert.ok(result.actions.some(a=>a.kind==="receive-issue-outcome"));
});

test("off-origin pagination refuses rather than leaking the GitHub credential",async()=>{
 const calls=[];
 const fetchImpl=async(url,init)=>{
   calls.push({url,auth:init.headers.authorization});
   return {ok:true,status:200,headers:new Headers({
     link:'<https://attacker.invalid/steal>; rel="next"'
   }),text:async()=>JSON.stringify([{name:"safe"}])};
 };
 const client=createClient({token:"secret",fetchImpl});
 let blocked=false;
 try{await client.paginate("/repos/o/r/branches")}catch(e){
   blocked=/outside authorized API origin/.test(e.message);
 }
 assert.equal(blocked,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://api.github.com/repos/o/r/branches?per_page=100");
});

test("createClient follows Link rel=next and sends the token", async () => {
  const calls = [];
  const pages = {
    "https://api.github.com/x?per_page=100": [[{ n: 1 }], '<https://api.github.com/x?page=2>; rel="next"'],
    "https://api.github.com/x?page=2": [[{ n: 2 }], null],
  };
  const fetchImpl = async (url, init) => {
    calls.push(init.headers.authorization);
    const [body, link] = pages[url];
    return { ok: true, status: 200, headers: new Headers(link ? { link } : {}), text: async () => JSON.stringify(body) };
  };
  const items = await createClient({ token: "t", fetchImpl }).paginate("/x");
  assert.deepEqual(items, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(calls, ["Bearer t", "Bearer t"]);
});

test("GitHub check_runs envelope is not silently read as zero checks", async () => {
  const calls = [];
  const pages = {
    "https://api.github.com/repos/o/r/commits/c/check-runs?per_page=100":
      [{ total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }] },
        '<https://api.github.com/repos/o/r/commits/c/check-runs?page=2>; rel="next"'],
    "https://api.github.com/repos/o/r/commits/c/check-runs?page=2":
      [{ total_count: 2, check_runs: [{ status: "completed", conclusion: "failure" }] }, null],
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    const [body, link] = pages[url];
    return { ok: true, status: 200, headers: new Headers(link ? { link } : {}),
      text: async () => JSON.stringify(body) };
  };
  const runs = await createClient({ fetchImpl }).paginate("/repos/o/r/commits/c/check-runs");
  assert.equal(runs.length, 2);
  assert.equal(checksState({ checkRuns: runs, status: { total_count: 0, state: "success" } }), "failing");
  assert.equal(calls.length, 2);
});

test("truncated, inconsistent and unknown GitHub check collections fail closed", async () => {
  for (const body of [
    { total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }] },
    { total_count: "1", check_runs: [] },
    { total_count: 1, unrecognized: [{ status: "completed", conclusion: "success" }] },
  ]) {
    const client = createClient({ fetchImpl: async () => ({
      ok: true, status: 200, headers: new Headers(),
      text: async () => JSON.stringify(body),
    }) });
    await assert.rejects(client.paginate("/repos/o/r/commits/c/check-runs"),
      /incomplete|total_count|unsupported collection envelope/u);
  }
});

test("unavailable GitHub check-runs cannot be masked by passing commit statuses", async () => {
  const routes = world();
  delete routes["LIST /repos/o/r/commits/g1/check-runs"];
  routes["GET /repos/o/r/commits/g1/status"] = { total_count: 1, state: "success" };
  const { client, writes } = fake(routes);
  const result = await reconcileRepo(client, repo, {
    mergeGreenPulls: true, now: NOW,
  });
  assert.deepEqual(writes,[],"an unavailable check source cannot cause any effect");
  assert.ok(result.debts.some(d => d.id.includes("checks-unavailable")));
  assert.equal(result.actions.some(a=>a.kind==="receive-pull-source"&&a.target===5),false);
});

test("source-observer never issues even a seemingly successful PR merge",async()=>{
 const routes=world();
 routes["GET /repos/o/r/pulls/5"]={...routes["GET /repos/o/r/pulls/5"],body:"Fixes #42"};
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{mergeGreenPulls:true,closeIssues:true,now:NOW});
 assert.deepEqual(writes,[]);
 assert.equal(result.actions.find(x=>x.kind==="receive-pull-source").originalWorkReceiving,"not-observed");
 assert.equal(summarize([result]).pullRequestsMerged,0);
 assert.equal(summarize([result]).issuesClosed,0);
});

test("archive tag ref and contained branch remain distinct unreceived source",async()=>{
 const routes=world(),tip="d".repeat(40);
 routes["LIST /repos/o/r/branches"][1].commit.sha=tip;
 const tag="refs/tags/archive/agent/one-unreceived-work";
 routes["GET /repos/o/r/git/matching-refs/tags/archive/"]=[
   {ref:tag,object:{type:"commit",sha:tip}}];
 routes["GET /repos/o/r/compare/"+"a".repeat(40)+"..."+tip]=
   {ahead_by:0,behind_by:5,status:"behind"};
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW,closeIssues:true});
 assert.equal(result.sourceObservations.length,1);
 assert.equal(result.sourceObservations[0].refName,tag);
 assert.equal(result.sourceObservations[0].originalIssueReceiving,"not-observed");
 assert.equal(result.sourceObservations[0].automaticRefRetirementAllowed,false);
 const held=result.sourceCandidates.find(x=>x.refName==="refs/heads/done");
 assert.deepEqual(held.matchingArchiveRefNames,[tag]);
 assert.equal(held.automaticRefRetirementAllowed,false);
 assert.equal(summarize([result]).branchesHeldByArchiveSource,1);
 assert.equal(summarize([result]).archiveTagSourcesAwaitingReceiving,1);
 assert.deepEqual(writes,[]);
});

test("merged PR's closing keyword is not a supported issue closure or approval",async()=>{
 for(const flags of [{closeIssues:true},{closeIssues:false},{mergeGreenPulls:true}]){
  const {client,writes}=fake(world());
  const result=await reconcileRepo(client,repo,{now:NOW,...flags});
  const issue=result.actions.find(a=>a.kind==="receive-issue-outcome"&&a.target===40);
  assert.equal(issue.recordKind,"github.issue-outcome-receiving-candidate/v1");
  assert.equal(issue.originalWorkReceiving,"not-observed");
  assert.equal(issue.independentBeneficiaryReceiving,"not-observed");
  assert.equal(issue.automaticClosureAllowed,false);
  assert.deepEqual(writes,[]);
  assert.equal(summarize([result]).issuesClosed,0);
 }
});

test("foreign fork naming a local branch does not grant ref retirement",async()=>{
 const routes=world();
 routes["LIST /repos/o/r/pulls?state=open"][1].head={
  ref:"done",repo:{full_name:"someone-else/r"},sha:"r1"};
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 const branch=result.sourceCandidates.find(x=>x.refName==="refs/heads/done");
 assert.equal(branch.automaticRefRetirementAllowed,false);
 assert.equal(branch.technicalClassification,"contained-in-default");
});


test("source reader has no hidden GitHub merge, issue-close or ref-delete calls",()=>{
 const source=readFileSync(new URL("../src/reconcile.mjs",import.meta.url),"utf8");
 assert.doesNotMatch(source,/client\.request\("(?:POST|PUT|PATCH|DELETE)"/u);
 assert.equal(DELETABLE_BRANCH_CLASSES.size,0);
 assert.equal(SOURCE_CONTAINMENT_CLASSES.has("contained-in-default"),true);
});


test("all open original issue sources reach the same typed result without a closing keyword",async()=>{
 const routes=world();
 routes["LIST /repos/o/r/pulls?state=closed&sort=updated&direction=desc"]=[];
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 assert.equal(result.originalIssueSources.length,3);
 assert.equal(summarize([result]).originalIssuesObserved,3);
 assert.ok(result.originalIssueSources.every(row=>row.recordKind==="github.issue-source-observation/v1"
   &&row.repositoryId===12345&&row.issueState==="open"
   &&row.closingKeywordMergedPullRequestUrl===null
   &&row.originalWorkReceiving==="not-observed"
   &&row.automaticIssueClosureAllowed===false));
 assert.equal(result.originalIssueSources[0].issueId,140);
 assert.equal(result.originalIssueSources[0].issueNumber,40);
 assert.equal(result.originalIssueSources[0].issueUpdatedAt,OLD);
 assert.equal(result.actions.some(row=>row.kind==="receive-issue-outcome"),false);
});

test("duplicate or unversioned original issue source must refuse, never invent an empty inventory",async()=>{
 for(const issues of [
   [{id:20,number:1,state:"open",updated_at:OLD},
    {id:20,number:2,state:"open",updated_at:OLD}],
   [{id:20,number:1,state:"open",updated_at:OLD},
    {id:21,number:1,state:"open",updated_at:OLD}],
   [{number:1,state:"open",updated_at:OLD}],
   [{id:20,number:1,state:"open"}],
   [{id:20,number:1,state:"closed",updated_at:OLD}]
 ]){
   const routes=world();routes["LIST /repos/o/r/issues?state=open"]=issues;
   const {client,writes}=fake(routes);
   await assert.rejects(reconcileRepo(client,repo,{now:NOW}),
     /issue identity, revision or source coverage is incomplete/u);
   assert.deepEqual(writes,[]);
 }
});

test("skipped-only original check runs never produce an accepted PR source candidate",async()=>{
 const routes=world();
 routes["LIST /repos/o/r/commits/g1/check-runs"]=[{status:"completed",conclusion:"skipped"}];
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 assert.equal(result.actions.some(a=>a.kind==="receive-pull-source"&&a.target===5),false);
 assert.ok(result.debts.some(row=>row.id.includes("checks-inconclusive")));
});
test("GitHub base comparison at 300 files remains incomplete rather than a green review",async()=>{
 const routes=world();
 routes["GET /repos/o/r/compare/b...main"]={
  files:Array.from({length:300},(_,n)=>({filename:"path-"+n+".mjs"}))
 };
 const {client,writes}=fake(routes);
 const result=await reconcileRepo(client,repo,{now:NOW});
 assert.deepEqual(writes,[]);
 assert.equal(result.actions.some(a=>a.kind==="receive-pull-source"&&a.target===5),false);
 assert.ok(result.debts.some(row=>row.id.includes("base-difference-incomplete")));
});

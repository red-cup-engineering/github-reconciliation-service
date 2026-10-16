import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(checksState({ checkRuns: [], status: { total_count: 0, state: "pending" } }), "none");
  assert.equal(checksState({ checkRuns: [], status: { total_count: 1, state: "failure" } }), "failing");
});

test("branchClass deletes only what the default branch already holds", () => {
  const base = { defaultBranch: "main", mergedHeadShas: new Set(["abc"]), openPullHeads: new Set(["open"]), isProtected: false, ahead_by: 3 };
  const branch = (name, sha = "zzz") => ({ name, commit: { sha } });
  assert.equal(branchClass({ ...base, branch: branch("main") }), "default");
  assert.equal(branchClass({ ...base, branch: branch("open"), ahead_by: 0 }), "has-open-pull-request");
  assert.equal(branchClass({ ...base, branch: branch("x"), ahead_by: 0 }), "contained-in-default");
  assert.equal(branchClass({ ...base, branch: branch("squashed", "abc") }), "unique-commits");
  assert.equal(branchClass({ ...base, branch: branch("work") }), "unique-commits");
  assert.equal(branchClass({ ...base, branch: branch("rel"), isProtected: true, ahead_by: 0 }), "protected");
});

test("pullClass orders its tests: draft, unknown, superseded, conflict, checks, cleanliness", () => {
  const pull = (over = {}) => ({ base: { ref: "main" }, draft: false, mergeable: true, mergeable_state: "clean", ...over });
  const args = (over = {}, extra = {}) => ({ pull: pull(over), checks: "passing", files: ["a"], changedOnBase: new Set(), defaultBranch: "main", ...extra });
  assert.equal(pullClass(args()), "green-and-mergeable");
  assert.equal(pullClass(args({ draft: true })), "draft");
  assert.equal(pullClass(args({ mergeable: null })), "mergeability-unknown");
  assert.equal(pullClass(args({}, { changedOnBase: new Set(["a", "b"]) })), "superseded-by-changes-on-default");
  assert.equal(pullClass(args({ mergeable: false, mergeable_state: "dirty" })), "conflicting");
  assert.equal(pullClass(args({}, { checks: "failing" })), "checks-failing");
  assert.equal(pullClass(args({}, { checks: "none" })), "no-checks");
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
  const client = {
    async request(method, path, body) {
      if (method !== "GET") { writes.push({ method, path, body }); return null; }
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
  "GET /repos/o/r": { default_branch: "main" },
  "LIST /repos/o/r/branches": [
    { name: "main", protected: false, commit: { sha: "m" } },
    { name: "done", protected: false, commit: { sha: "d" } },
    { name: "squashed", protected: false, commit: { sha: "s1" } },
    { name: "work", protected: false, commit: { sha: "w" } },
    { name: "pr-green", protected: false, commit: { sha: "g1" } },
  ],
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
  "GET /repos/o/r/compare/main...squashed": { ahead_by: 2 },
  "GET /repos/o/r/compare/main...work": { ahead_by: 4 },
  "GET /repos/o/r/compare/main...pr-green": { ahead_by: 1 },
  "GET /repos/o/r/commits/w": { commit: { committer: { date: OLD } } },
  "LIST /repos/o/r/issues?state=open": [
    { number: 40 }, { number: 41 }, { number: 42 }, { number: 43, pull_request: {} },
  ],
});

test("a dry run reads everything and writes nothing", async () => {
  const { client, writes } = fake(world());
  const result = await reconcileRepo(client, repo, { now: NOW });
  assert.deepEqual(writes, []);
  assert.deepEqual(result.actions.map((a) => `${a.kind}:${a.target}:${a.applied}`).sort(), [
    "delete-branch:done:false", "merge-pull-request:5:false",
  ]);
});

test("apply merges the green pull request, deletes contained branches, closes the fixed issue, records the rest", async () => {
  const { client, writes } = fake(world());
  const result = await reconcileRepo(client, repo, { apply: true, closeIssues: true, now: NOW });
  const sent = writes.map((w) => `${w.method} ${w.path}`);
  assert.ok(sent.includes("PUT /repos/o/r/pulls/5/merge"));
  assert.deepEqual(writes.find((w) => w.method === "PUT").body, { merge_method: "squash", sha: "g1" });
  assert.ok(sent.includes("DELETE /repos/o/r/git/refs/heads/done"));
  assert.ok(!sent.includes("DELETE /repos/o/r/git/refs/heads/squashed"));
  assert.ok(!sent.some((s) => s.includes("heads/work") || s.includes("heads/main") || s.includes("heads/pr-green")));
  assert.ok(sent.includes("PATCH /repos/o/r/issues/40"));
  assert.ok(!sent.some((s) => s.includes("issues/41") || s.includes("issues/42") || s.includes("issues/43")));
  assert.deepEqual(result.debts.map((d) => d.id).sort(), ["github-o-r-branch-work-unique-commits", "github-o-r-pull-request-6-conflicting"]);
  assert.deepEqual(summarize([result]), { repos: 1, branchesDeleted: 1, branchesDeletable: 1, pullRequestsMerged: 1, pullRequestsMergeable: 1, issuesClosed: 1, issuesClosable: 1, debtRecords: 2 });
});

test("issue closure is opt-in and unique squashed history is preserved", async () => {
  const { client, writes } = fake(world());
  const result = await reconcileRepo(client, repo, { apply: true, now: NOW });
  assert.ok(!writes.some(w => w.method === "PATCH" && w.path.includes("/issues/")));
  assert.ok(!writes.some(w => w.method === "DELETE" && w.path.includes("heads/squashed")));
  assert.ok(result.actions.some(a => a.kind === "delete-branch" && a.target === "done" && a.applied));
});

test("max-merges caps merges per run", async () => {
  const { client, writes } = fake(world());
  await reconcileRepo(client, repo, { apply: true, maxMerges: 0, now: NOW });
  assert.ok(!writes.some((w) => w.method === "PUT"));
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

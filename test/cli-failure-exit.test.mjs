import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/github-reconcile.mjs", import.meta.url));

// Observe the real CLI process result without accounts, network, or effects.
// One repository has a complete (empty) GitHub estate; the other refuses.
test("repository read failure produces nonzero process status and truthful partial reporting", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-reconcile-cli-"));
  try {
    const preload = join(dir, "mock-fetch.mjs");
    writeFileSync(preload, `
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  const routes = {
    "/repos/o/r": { id: 12345, default_branch: "main" },
    "/repos/o/r/branches": [{name:"main",protected:false,commit:{sha:"a".repeat(40)}}],
    "/repos/o/r/pulls": [],
    "/repos/o/r/issues": [],
    "/repos/o/r/git/matching-refs/tags/archive/": []
  };
  const allowed = init.method === "GET" && Object.hasOwn(routes, path);
  return {
    ok: allowed,
    status: allowed ? 200 : 503,
    headers: new Headers(),
    text: async () => JSON.stringify(allowed ? routes[path] : { message: "source unavailable" })
  };
};`, "utf8");
    const invoke = (...repos) => spawnSync(process.execPath,
      ["--import", preload, cli, ...repos.flatMap(repo => ["--repo", repo])], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_TOKEN: "fixture-token" },
      });
    const complete = invoke("o/r");
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(complete.error, undefined);
    const success = JSON.parse(complete.stdout);
    assert.equal(success.repos, 1);
    assert.equal(success.repositoriesObserved, 1);
    assert.equal(success.repositoriesFailed, 0);
    assert.deepEqual(success.errors, []);
    assert.equal(success.archiveRefCoverage,"complete-for-observed-repositories");
    assert.deepEqual(success.archiveRefSources,[]);
    assert.deepEqual(success.originalIssueSources,[]);
    assert.equal(success.originalIssuesObserved,0);
    assert.equal(success.archiveTagSourcesObserved,0);

    const mixed = invoke("o/r", "x/y");
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.equal(mixed.error, undefined);
    const report = JSON.parse(mixed.stdout);
    assert.equal(report.repos, 2);
    assert.equal(report.repositoriesObserved, 1);
    assert.equal(report.repositoriesFailed, 1);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].repo, "x/y");
    assert.equal(report.applied, false);
    assert.equal(report.archiveRefCoverage,"incomplete",
      "an unreadable repository must not imply a complete archive-tag census");
    assert.deepEqual(report.actions, []);
    assert.match(mixed.stderr, /x\/y:.*503/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The actual CLI must refuse unreceived effects even without a token.
// This is a process-level native boundary, not only an imported helper.
test("--apply refuses before credential access or GitHub network requests",()=>{
 const command=spawnSync(process.execPath,[cli,"--repo","o/r","--apply"],{
   encoding:"utf8",env:{...process.env,GITHUB_TOKEN:"",CREDENTIALS_DIRECTORY:""}});
 assert.notEqual(command.status,0);
 assert.match(command.stderr,/--apply refused/u);
 assert.doesNotMatch(command.stderr,/no token:/u);
});

test("--register refuses before credential access and never creates orphan debt JSON",()=>{
 const attempt=spawnSync(process.execPath,[cli,"--repo","o/r","--register","/tmp/unused"],{
   encoding:"utf8",env:{...process.env,GITHUB_TOKEN:"",CREDENTIALS_DIRECTORY:""}});
 assert.notEqual(attempt.status,0);
 assert.match(attempt.stderr,/--register refused/u);
 assert.doesNotMatch(attempt.stderr,/no token:/u);
});

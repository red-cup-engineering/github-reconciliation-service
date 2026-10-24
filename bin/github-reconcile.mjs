#!/usr/bin/env node
/**
 * github-reconcile [--org NAME]... [--repo OWNER/NAME]...
 *                  [--receive-equivalent] [--max-equivalents N]
 *
 * Reads the token from $GITHUB_TOKEN, or from the systemd credential `github-token`
 * ($CREDENTIALS_DIRECTORY). This entry is always a read-only source observer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/github-client.mjs";
import { listRepos, reconcileRepo, summarize } from "../src/reconcile.mjs";
import { admitGitHubReconciliationSource } from "../src/source-report.mjs";

const argv = process.argv.slice(2);
if(argv.includes("--apply"))
  throw new TypeError("--apply refused: GitHub source observation alone cannot merge a PR, close Work or retire Git refs; use the original native receiving operations");
if(argv.includes("--register"))
  throw new TypeError("--register refused: the historical write-only debt JSON had no reader; use typed original GitHub source records");
const legacyFlags=new Set(["--min-age-days","--merge-green-pulls","--close-issues","--max-merges","--merge-method"]);
for(const flag of argv) {
  if(legacyFlags.has(flag))throw new TypeError(flag+" refused: obsolete effect/debt selector; original read-only source has no such action");
  if(flag.startsWith("--") && !["--repo","--org","--receive-equivalent","--max-equivalents"].includes(flag))
    throw new TypeError("unknown GitHub source flag "+flag);
}
const values = (flag) => argv.flatMap((arg,i) => {
  if(arg !== flag)return [];
  const value=argv[i+1];
  if(typeof value!=="string" || value.startsWith("--"))
    throw new TypeError("missing value for "+flag);
  return [value];
});
const one = (flag, fallback) => values(flag)[0] ?? fallback;
const token = process.env.GITHUB_TOKEN ?? (process.env.CREDENTIALS_DIRECTORY ? readFileSync(join(process.env.CREDENTIALS_DIRECTORY, "github-token"), "utf8").trim() : undefined);
if (!token) { console.error("no token: set GITHUB_TOKEN or provide the github-token credential"); process.exit(2); }

const client = createClient({ token });
const repos = [...new Set([...values("--repo"), ...(await listRepos(client,values("--org")))])];
if(repos.length===0 || repos.some(name=> !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(name)))
  throw new TypeError("provide at least one valid --repo OWNER/NAME or --org NAME");
const safeInt = (text,flag) => {
  const n=Number(text);
  if(!Number.isSafeInteger(n)||n<0)throw new TypeError(flag+" must be a nonnegative integer");
  return n;
};
const options = {
  receiveEquivalent:argv.includes("--receive-equivalent"),
  maxEquivalentMerges:safeInt(one("--max-equivalents",8),"--max-equivalents"),
};
// Both the source producer and its original Computer Engineering consumer
// admit this SAME transient typed result. A failed repository remains an error
// in the whole-estate observation, never an invented empty population.
const reportOf = (readings, errors) => ({
  recordKind:"github.reconciliation-source-report/v1",
  applied:false,...summarize(readings),
  repositoriesObserved:readings.length-errors.length,
  repositoriesFailed:errors.length,
  errors,
  actions:readings.flatMap(r=>r.actions),
  archiveRefSources:readings.flatMap(r=>r.sourceObservations??[]),
  branchSourceCandidates:readings.flatMap(r=>r.sourceCandidates??[]),
  pullSourceCandidates:readings.flatMap(r=>r.pullSourceCandidates??[]),
  originalIssueSources:readings.flatMap(r=>r.originalIssueSources??[]),
  archiveRefCoverage:errors.length?"incomplete":"complete-for-observed-repositories",
  sourceCutCoverage:errors.length?"incomplete":"matching-open-github-source-cuts",
});
const results=[];
for (const repo of repos) {
  try {
    const observed=await reconcileRepo(client,repo,options);
    if(observed.sourceCutCoverage!=="matching-open-github-source-cuts")
      throw new TypeError("original GitHub source cut incomplete");
    admitGitHubReconciliationSource(reportOf([observed],[]),{repository:repo});
    results.push(observed);
  } catch (error) {
    console.error(`${repo}: ${error.message}`);
    results.push({repo,actions:[],error:error.message});
  }
}
const errors=results.filter(r=>r.error).map(r=>({repo:r.repo,error:r.error}));
console.log(JSON.stringify(reportOf(results,errors),null,2));
// A partially observed repository estate is not a successful reconciliation.
// Keep the machine-readable receipt on stdout, but fail the invoking job.
if (errors.length) process.exitCode = 1;

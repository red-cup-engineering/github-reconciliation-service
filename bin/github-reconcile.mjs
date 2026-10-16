#!/usr/bin/env node
/**
 * github-reconcile [--org NAME]... [--repo OWNER/NAME]... [--apply] [--register DIR]
 *                  [--merge-green-pulls] [--receive-equivalent] [--max-equivalents N]
 *                  [--merge-method squash|merge|rebase] [--close-issues]
 *                  [--max-merges N] [--min-age-days N]
 *
 * Reads the token from $GITHUB_TOKEN, or from the systemd credential `github-token`
 * ($CREDENTIALS_DIRECTORY). Without --apply it only reports what it would do.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/github-client.mjs";
import { listRepos, reconcileRepo, summarize } from "../src/reconcile.mjs";

const argv = process.argv.slice(2);
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
const options = { apply:argv.includes("--apply"), mergeGreenPulls:argv.includes("--merge-green-pulls"),
  receiveEquivalent:argv.includes("--receive-equivalent"),
  maxEquivalentMerges:safeInt(one("--max-equivalents",8),"--max-equivalents"),
  closeIssues:argv.includes("--close-issues"),
  mergeMethod:one("--merge-method","squash"),
  maxMerges:safeInt(one("--max-merges",25),"--max-merges"),
  minAgeDays:safeInt(one("--min-age-days",2),"--min-age-days") };
if(!["merge","squash","rebase"].includes(options.mergeMethod))
  throw new TypeError("--merge-method must be merge, squash or rebase");
const results = [];
for (const repo of repos) {
  try { results.push(await reconcileRepo(client, repo, options)); }
  catch (error) { console.error(`${repo}: ${error.message}`); results.push({ repo, actions: [], debts: [], error: error.message }); }
}
const register = one("--register");
if (register) {
  mkdirSync(register, { recursive: true });
  for (const debt of results.flatMap((result) => result.debts)) writeFileSync(join(register, `${debt.id}.json`), JSON.stringify(debt, null, 2) + "\n");
}
console.log(JSON.stringify({ applied: options.apply, ...summarize(results), errors: results.filter((r) => r.error).map((r) => ({ repo: r.repo, error: r.error })), actions: results.flatMap((r) => r.actions) }, null, 2));

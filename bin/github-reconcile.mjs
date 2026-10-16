#!/usr/bin/env node
/**
 * github-reconcile [--org NAME]... [--repo OWNER/NAME]... [--apply] [--register DIR]
 *                  [--merge-method squash|merge|rebase] [--max-merges N] [--min-age-days N]
 *
 * Reads the token from $GITHUB_TOKEN, or from the systemd credential `github-token`
 * ($CREDENTIALS_DIRECTORY). Without --apply it only reports what it would do.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "../src/github-client.mjs";
import { listRepos, reconcileRepo, summarize } from "../src/reconcile.mjs";

const argv = process.argv.slice(2);
const values = (flag) => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]] : []));
const one = (flag, fallback) => values(flag)[0] ?? fallback;
const token = process.env.GITHUB_TOKEN ?? (process.env.CREDENTIALS_DIRECTORY ? readFileSync(join(process.env.CREDENTIALS_DIRECTORY, "github-token"), "utf8").trim() : undefined);
if (!token) { console.error("no token: set GITHUB_TOKEN or provide the github-token credential"); process.exit(2); }

const client = createClient({ token });
const repos = [...values("--repo"), ...(await listRepos(client, values("--org")))];
const options = { apply: argv.includes("--apply"), closeIssues: argv.includes("--close-issues"), mergeMethod: one("--merge-method", "squash"), maxMerges: Number(one("--max-merges", 25)), minAgeDays: Number(one("--min-age-days", 2)) };
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

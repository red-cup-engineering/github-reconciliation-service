import test from "node:test";
import assert from "node:assert/strict";
import { observeArchiveRefSources } from "../src/archive-ref-observation.mjs";

const repository = "561-group/internal-services-section";
const base = "a".repeat(40), old = "b".repeat(40), moved = "c".repeat(40);
const root = "/repos/" + repository;
const custom = "refs/archive/2026-10-11/unfinished-research";
const selection = {
  repository, repositoryId: 1410773297, observedBaseCommitId: base,
  observedBaseRefName: "refs/heads/main", includeCustomRefs: true,
};
function provider({ moving = false, extraTag = false } = {}) {
  let observed = 0; const requested = [];
  const client = { async request(method, path) {
    requested.push([method, path]);
    assert.equal(method, "GET", "archive observation cannot mutate Git");
    if (path === root + "/git/matching-refs/tags/archive/")
      return extraTag ? [{ ref: "refs/tags/archive/older", object: { type: "commit", sha: old } }] : [];
    if (path === root + "/git/matching-refs/archive/")
      return [{ ref: custom, object: { type: "commit", sha: moving && ++observed > 1 ? moved : old } }];
    if (path === root + "/compare/" + base + "..." + old) return { ahead_by: 2, behind_by: 9 };
    if (path === root + "/git/ref/heads/main") return { ref: "refs/heads/main", object: { type: "commit", sha: base } };
    throw new Error("Missing exact provider source: " + path);
  } };
  return { client, requested };
}
test("native custom ref is a separately witnessed Git object, never an accepted archive", async () => {
  const { client, requested } = provider();
  const result = await observeArchiveRefSources(client, selection);
  assert.equal(result.length, 1);
  assert.equal(result[0].refName, custom);
  assert.equal(result[0].gitObjectId, old);
  assert.equal(result[0].peeledCommitId, old);
  assert.equal(result[0].technicalRelation, "divergent-source-history");
  assert.equal(result[0].automaticRefRetirementAllowed, false);
  assert.equal(result[0].independentReceivingRequired, true);
  assert.equal(requested.filter(([,path])=>path.endsWith("matching-refs/archive/")).length, 2);
});
test("moving ref and combined source-count overflow cannot produce a partial observation", async () => {
  await assert.rejects(observeArchiveRefSources(provider({moving:true}).client, selection), /ref identities changed/);
  await assert.rejects(observeArchiveRefSources(provider({extraTag:true}).client,
    { ...selection, maxRefs: 1 }), /Combined original Git archive namespaces/);
});

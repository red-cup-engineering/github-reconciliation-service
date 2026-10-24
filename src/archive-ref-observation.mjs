/**
 * GitHub-specific read adapter for existing Git Services stranded-ref receiving.
 *
 * This is a provider observation, NOT a second Git archive classifier, a
 * source-owned Work register or a receipt. Git Engineering owns the normative
 * git.ref-source-observation/v1 and native commit/tree analysis. A tag under
 * refs/tags/archive/ is only a ref to original possibly unprocessed code.
 *
 * The canonical GitHub REST Git refs and annotated-tag objects, not tag
 * naming conventions or issue-title searches, supply the identifiers.
 */
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PREFIX = "refs/tags/archive/";
const MAX_REFS = 128;
const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const objectKinds = new Set(["commit", "tag", "tree", "blob"]);
const make = obj => Object.freeze(obj);
const exact = (kind,sha) => objectKinds.has(kind) && typeof sha === "string" && GIT_OID.test(sha);
const repoPath = repository => {
  if (typeof repository !== "string" || !/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(repository))
    throw new TypeError("exact owner/repository is required for GitHub ref receiving");
  return repository.split("/").map(encodeURIComponent).join("/");
};
function nameOf(tagRef) {
  if (!isObject(tagRef) || typeof tagRef.ref !== "string" ||
      !tagRef.ref.startsWith(PREFIX) || tagRef.ref.length <= PREFIX.length ||
      /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(tagRef.ref) ||
      /\.\.|@\{|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/u.test(tagRef.ref.slice(PREFIX.length)))
    throw new TypeError("GitHub returned an unsafe or non-archive-tag ref");
  return tagRef.ref;
}

/**
 * Read every original archive-named tag available within a strict finite
 * provider collection. Output feeds the EXISTING Git Engineering/Coesite
 * source and Work receiving; no tag, branch, issue or Work state is mutated.
 *
 * @returns {Promise<ReadonlyArray<Readonly<object>>>}
 */
export async function observeArchiveRefSources(client,{repository,repositoryId,observedBaseCommitId,maxRefs=MAX_REFS}) {
  const escapedRepo = repoPath(repository);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !GIT_OID.test(observedBaseCommitId))
    throw new TypeError("source repo numeric ID and exact observed base commit required");
  if (!Number.isSafeInteger(maxRefs) || maxRefs < 1 || maxRefs > MAX_REFS)
    throw new RangeError("archive ref source limit must be 1..128");
  const refs = await client.request("GET", `/repos/${escapedRepo}/git/matching-refs/tags/archive/`);
  if (!Array.isArray(refs) || refs.length > maxRefs)
    throw new RangeError("GitHub archive reference inventory incomplete or unbounded");
  const names = new Set();
  const sorted = [...refs].sort((a,b)=>String(a?.ref).localeCompare(String(b?.ref)));
  // Validate the ENTIRE bounded provider page before additional network reads.
  // Otherwise one bad later ref could make us spend an RPC on a partial census.
  const admitted = sorted.map(ref=>{
    const refName=nameOf(ref);
    if(names.has(refName) || !exact(ref.object?.type,ref.object?.sha))
      throw new TypeError("duplicate or malformed GitHub archive ref observation");
    names.add(refName);
    return {ref,refName};
  });
  const observations = [];
  for(const {ref,refName} of admitted){
    const gitObjectId = ref.object.sha;
    const gitObjectKind = ref.object.type;
    let cursor = ref.object,peeledCommitId = null;
    const seenObjects = new Set();
    // Git annotated tags may point at other tags or noncommit objects.
    // Do not flatten these to a guessed commit, or lose the original tag OID.
    for(let depth=0;depth<5;depth++){
      if(cursor.type==="commit"){peeledCommitId=cursor.sha;break;}
      if(cursor.type!=="tag")break;
      if(seenObjects.has(cursor.sha))
        throw new TypeError("GitHub annotated tag object cycle is not an admitted source");
      seenObjects.add(cursor.sha);
      const tag=await client.request("GET",`/repos/${escapedRepo}/git/tags/${cursor.sha}`);
      if(!isObject(tag) || tag.sha!==cursor.sha ||
         !exact(tag.object?.type,tag.object?.sha) ||
         (depth===0 && tag.tag!==refName.slice("refs/tags/".length)))
        throw new TypeError("GitHub annotated tag readback identity mismatch");
      cursor=tag.object;
    }
    let aheadCommitCount=null,behindCommitCount=null;
    let technicalRelation="noncommit-or-unpeeled-ref";
    if(peeledCommitId!==null){
      const compare = await client.request("GET",`/repos/${escapedRepo}/compare/${observedBaseCommitId}...${peeledCommitId}`);
      if(!isObject(compare) || !Number.isSafeInteger(compare.ahead_by) ||
         !Number.isSafeInteger(compare.behind_by) ||
         compare.ahead_by<0 || compare.behind_by<0)
        throw new TypeError("GitHub commit comparison was not independently observed");
      aheadCommitCount=compare.ahead_by;
      behindCommitCount=compare.behind_by;
      technicalRelation=peeledCommitId===observedBaseCommitId ? "same-base-commit"
        : aheadCommitCount===0 ? "source-history-contained-in-base"
        : behindCommitCount===0 ? "source-history-ahead-of-base"
        : "divergent-source-history";
    }
    observations.push(make({
      recordKind:"github.archive-ref-source-observation/v1",
      repository,repositoryId,
      refName,gitObjectKind,gitObjectId,peeledCommitId,
      observedBaseCommitId,aheadCommitCount,behindCommitCount,technicalRelation,
      changedPathCoverage:"not-established-by-commit-count",
      originalIssueReceiving:"not-observed",
      originalConsumerReceiving:"not-observed",
      independentReceivingRequired:true,
      automaticRefRetirementAllowed:false,
      nextOwner:"Git Engineering native source then Coesite original Work/consumer receiving",
    }));
  }
  return Object.freeze(observations);
}

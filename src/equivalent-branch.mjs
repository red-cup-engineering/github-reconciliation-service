/**
 * Content-equivalence receipt for a divergent GitHub branch.
 *
 * A unique commit is NEVER safe to delete merely because an old PR was
 * squash-merged. Instead, compare all changed CURRENT file/submodule
 * blobs against the default branch. If every blob matches, a real Git
 * merge may receive the historical commits without changing the current
 * worktree. Keep deletion under GitHub's normal merge/branch rules.
 *
 * Compare's files array is truncated at 300. Decline incomplete, very
 * large, renamed, removed, symlinked or uninspectable changes rather
 * than manufacture a conclusion from a partial diff.
 */
const encodedPath = value => value.split("/").map(encodeURIComponent).join("/");
const ACCEPTED = new Set(["added","modified","changed"]);

export async function branchContentEquivalence(client,repo,base,head,compare,{
  maxFiles=24,
}={}) {
  const failed=(reason)=>Object.freeze({
    kind:"github.branch-content-equivalence.v1",equivalent:false,
    reason,examined:Object.freeze([]),
  });
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>=300)
    throw new RangeError("equivalent branch: maxFiles must be 1..299");
  if(!compare||!Number.isSafeInteger(compare.ahead_by)||compare.ahead_by<=0||
      compare.too_large===true||!Array.isArray(compare.files)||
      compare.files.length===0||compare.files.length>maxFiles||
      compare.files.length>=300)
    return failed("comparison-incomplete-or-unbounded");
  const entries=[],seen=new Set();
  for(const file of compare.files){
    const filename=file?.filename;
    if(typeof filename!=="string"||!filename||
       !ACCEPTED.has(file.status)||seen.has(filename)||
       typeof file.previous_filename==="string")
      return failed("unsafe-file-change");
    seen.add(filename);
    const target=encodedPath(filename);
    let a,b;
    try{
      [a,b]=await Promise.all([
        client.request("GET",`/repos/${repo}/contents/${target}?ref=${encodeURIComponent(base)}`),
        client.request("GET",`/repos/${repo}/contents/${target}?ref=${encodeURIComponent(head)}`),
      ]);
    }catch{
      return failed("content-unavailable");
    }
    if(!a||!b||Array.isArray(a)||Array.isArray(b)||
       typeof a.sha!=="string"||!a.sha||
       a.sha!==b.sha||a.type!==b.type||
       !["file","submodule"].includes(a.type))
      return failed("different-or-unqualified-blob");
    entries.push(Object.freeze({filename,sha:a.sha,type:a.type}));
  }
  return Object.freeze({
    kind:"github.branch-content-equivalence.v1",equivalent:true,
    reason:null,examined:Object.freeze(entries),
  });
}

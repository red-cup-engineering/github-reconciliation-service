import { branchContentEquivalence } from "./equivalent-branch.mjs";

const parts=value=>value.split("/").map(encodeURIComponent).join("/");
const failure=(reason,extra={})=>Object.freeze({
  kind:"github.branch-equivalent-receiving.v1",
  received:false,deleted:false,reason,...extra,
});

/**
 * Receive distinct Git HISTORY only if every changed current file/Gitlink
 * blob is already in main. The branch is merged, never reset or deleted as
 * "squashed". All PRs opened here are merged now or CLOSED before returning.
 * A completed merge preserves original commits under a real merge parent.
 *
 * The GitHub connection must have approved source/PR/ref permissions. This
 * call does not authorize source edits, CI bypass of DIFFERENT file content,
 * remote effects, historical migrations or branch-name reuse.
 */
export async function receiveEquivalentBranch(client,{
  repo,base,branch,baseSha,headSha,compare,apply=false,
}){
  const proof=await branchContentEquivalence(client,repo,base,branch,compare);
  if(!proof.equivalent)return failure(proof.reason,{fileCount:0});
  const candidate={
    kind:"github.branch-equivalent-receiving.v1",
    fileCount:proof.examined.length,
    sourceHead:headSha,
    baseHead:baseSha,
    verifiedFiles:proof.examined,
  };
  if(!apply)return Object.freeze({...candidate,received:false,deleted:false,reason:"dry-run"});
  let pr=null,received=false,receiptSha=null;
  try {
    const [source,baseRef,branchInfo,openPulls]=await Promise.all([
      client.request("GET",`/repos/${repo}/git/ref/heads/${parts(branch)}`),
      client.request("GET",`/repos/${repo}/git/ref/heads/${parts(base)}`),
      client.request("GET",`/repos/${repo}/branches/${parts(branch)}`),
      client.paginate(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split("/")[0]+":"+branch)}`),
    ]);
    if(typeof headSha!=="string"||typeof baseSha!=="string"||
       source.object?.sha!==headSha||baseRef.object?.sha!==baseSha||
       branchInfo.commit?.sha!==headSha||branchInfo.protected!==false||
       !Array.isArray(openPulls)||openPulls.length!==0)
      return failure("ref-protection-pr-or-base-changed",{...candidate});
    pr=await client.request("POST",`/repos/${repo}/pulls`,{
      title:"Receive already-integrated history: "+branch,
      head:branch,
      base,
      draft:false,
      body:"Every changed file/submodule blob at "+headSha+
        " was independently verified equal to "+base+" at "+baseSha+
        ". Preserve unique commit history with a real merge and retire the source branch. "+
        "This is NOT a generic permission to merge any non-equivalent PR.",
    });
    if(!Number.isSafeInteger(pr?.number)||pr.number<1)
      throw new TypeError("GitHub returned no usable created PR number");
    const merge=await client.request("PUT",`/repos/${repo}/pulls/${pr.number}/merge`,{
      merge_method:"merge",sha:headSha,
    });
    if(merge?.merged!==true||typeof merge?.sha!=="string")
      throw new Error("GitHub did not confirm the equivalent-history merge");
    received=true;receiptSha=merge.sha;
    const refPath=`/repos/${repo}/git/ref/heads/${parts(branch)}`;
    const deleted=async()=>{
      try{await client.request("GET",refPath);return false}
      catch(error){if(error.status===404)return true;throw error}
    };
    let gone=await deleted();
    if(!gone){
      // If GitHub auto-delete is disabled, use the SAME guarded containment
      // contract as ordinary cleanup, now that a true merge has received head.
      const [head,info,comparison,remainingOpen]=await Promise.all([
        client.request("GET",refPath),
        client.request("GET",`/repos/${repo}/branches/${parts(branch)}`),
        client.request("GET",`/repos/${repo}/compare/${parts(base)}...${parts(branch)}`),
        client.paginate(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split("/")[0]+":"+branch)}`),
      ]);
      if(head.object?.sha===headSha&&info.commit?.sha===headSha&&
         info.protected===false&&comparison.ahead_by===0&&
         Array.isArray(remainingOpen)&&remainingOpen.length===0){
        await client.request("DELETE",`/repos/${repo}/git/refs/heads/${parts(branch)}`);
        gone=await deleted();
      }
    }
    return Object.freeze({
      ...candidate,received:true,deleted:gone,
      reason:gone?null:"merge-received-but-branch-retirement-unverified",
      prNumber:pr.number,mergeSha:receiptSha,
    });
  }catch(error){
    let closeProblem=null;
    if(pr?.number&&!received){
      try{await client.request("PATCH",`/repos/${repo}/pulls/${pr.number}`,{state:"closed"})}
      catch(closeError){closeProblem=closeError.message}
    }
    return failure(received?"merge-received-but-deletion-unverified":
      "equivalent-branch-receiving-failed",{...candidate,
        ...(pr?.number?{prNumber:pr.number}:{}),
        ...(receiptSha?{mergeSha:receiptSha}:{}),
        ... (closeProblem?{closeProblem}:{}),
        detail:error.message,received});
  }
}

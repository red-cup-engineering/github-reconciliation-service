import { branchContentEquivalence } from "./equivalent-branch.mjs";

const assessment=(reason,extra={})=>Object.freeze({
  recordKind:"github.branch-source-equivalence-assessment/v1",
  received:false,deleted:false,reason,
  originalWorkReceiving:"not-observed",ordinaryConsumerReceiving:"not-observed",
  automaticRefRetirementAllowed:false,effectPermitted:false,
  ...extra,
});

/**
 * Read exact branch/source byte-equivalence through the existing GitHub
 * content reader. This legacy public entrance performs NO GitHub write.
 *
 * A matching Git blob, Gitlink or file mode is not receiving of original
 * requirements, unique history, operational consumers or public outcomes.
 * The original revision-leased GitHub Engineering receiver owns integration.
 */
export async function assessEquivalentBranchSource(client,{
  repo,base,branch,baseSha,headSha,compare,apply=false,
}={}){
  if(apply)return assessment("original-native-work-and-consumer-receiving-required",{
    sourceHead:headSha??null,baseHead:baseSha??null,fileCount:0,
    sourceAuthority:"none; original revision-bound GitHub receiver required"
  });
  const proof=await branchContentEquivalence(client,repo,base,branch,compare);
  if(!proof.equivalent)return assessment(proof.reason,{fileCount:0,verifiedFiles:Object.freeze([])});
  return assessment("dry-run",{
    fileCount:proof.examined.length,
    sourceHead:headSha,
    baseHead:baseSha,
    verifiedFiles:Object.freeze([...proof.examined]),
    firstReceivingAction:"receive-source-history-and-ordinary-consumer-through-original-native-owner",
  });
}

/** Legacy symbol retained for existing callers, without its old write powers. */
export const receiveEquivalentBranch=assessEquivalentBranchSource;

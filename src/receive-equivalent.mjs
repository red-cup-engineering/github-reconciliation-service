import { branchContentEquivalence } from "./equivalent-branch.mjs";

const failure=(reason,extra={})=>Object.freeze({
  kind:"github.branch-equivalent-receiving.v1",
  received:false,deleted:false,reason,...extra,
});

/**
 * Read exact branch/source byte-equivalence through the existing GitHub
 * content reader. This legacy public entrance performs NO GitHub write.
 *
 * A matching Git blob, Gitlink or file mode is not receiving of original
 * requirements, unique history, operational consumers or public outcomes.
 * The original revision-leased GitHub Engineering receiver owns integration.
 */
export async function receiveEquivalentBranch(client,{
  repo,base,branch,baseSha,headSha,compare,apply=false,
}={}){
  if(apply)return failure("original-native-work-and-consumer-receiving-required",{
    sourceHead:headSha??null,baseHead:baseSha??null,fileCount:0,
    sourceAuthority:"none; original revision-bound GitHub receiver required"
  });
  const proof=await branchContentEquivalence(client,repo,base,branch,compare);
  if(!proof.equivalent)return failure(proof.reason,{fileCount:0});
  return Object.freeze({
    kind:"github.branch-equivalent-receiving.v1",
    fileCount:proof.examined.length,
    sourceHead:headSha,
    baseHead:baseSha,
    verifiedFiles:Object.freeze([...proof.examined]),
    originalWorkReceiving:"not-observed",
    ordinaryConsumerReceiving:"not-observed",
    automaticRefRetirementAllowed:false,
    received:false,deleted:false,reason:"dry-run"
  });
}

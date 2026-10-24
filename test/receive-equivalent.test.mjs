import test from "node:test";
import assert from "node:assert/strict";
import { receiveEquivalentBranch } from "../src/receive-equivalent.mjs";

function fixture({same=true,autoDelete=true,protectedRef=false,changedMain=false,
  mergeBlocked=false,extraPR=false}={}){
 const calls=[];
 const base={sha:"m",type:"file"},branch={sha:same?"m":"b",type:"file"};
 let exists=true,received=false,openPR=false;
 const client={
  async request(method,path,body){
   calls.push({method,path,body});
   const get={
    "/repos/o/r/contents/src/a.mjs?ref=main":base,
    "/repos/o/r/contents/src/a.mjs?ref=codex%2Fold":branch,
    "/repos/o/r/git/ref/heads/codex/old":{object:{sha:"h"}},
    "/repos/o/r/git/ref/heads/main":{object:{sha:changedMain?"new":"m1"}},
    "/repos/o/r/branches/codex/old":{commit:{sha:"h"},protected:protectedRef},
    "/repos/o/r/compare/main...codex/old":{ahead_by:received?0:1},
   };
   if(method==="GET"){
    if(path==="/repos/o/r/git/ref/heads/codex/old"&&!exists)
      throw Object.assign(new Error("not found"),{status:404});
    if(!(path in get))throw new Error("missing "+path);
    return get[path];
   }
   if(method==="POST"&&path==="/repos/o/r/pulls"){
    openPR=true;
    return {number:42,head:{sha:"h"}};
   }
   if(method==="PUT"&&path==="/repos/o/r/pulls/42/merge"){
    if(mergeBlocked)throw Object.assign(new Error("conflict"),{status:405});
    received=true;if(autoDelete)exists=false;
    return {merged:true,sha:"merge1"};
   }
   if(method==="PATCH"&&path==="/repos/o/r/pulls/42"){
    openPR=false;return {state:"closed"};
   }
   if(method==="DELETE"&&path==="/repos/o/r/git/refs/heads/codex/old"){
    exists=false;return null;
   }
   throw new Error("unexpected "+method+" "+path);
  },
  async paginate(path){
    calls.push({method:"LIST",path});
    if(path==="/repos/o/r/pulls?state=open&head=o%3Acodex%2Fold")
      return extraPR?[{number:9}]:[];
    throw new Error("missing pagination "+path);
  },
 };
 const args={repo:"o/r",base:"main",branch:"codex/old",
   baseSha:"m1",headSha:"h",
   compare:{ahead_by:1,files:[{filename:"src/a.mjs",status:"modified"}]},
 };
 return{client,calls,args};
}

test("dry-run receives no historical commits and creates no PR",async()=>{
 const {client,calls,args}=fixture();
 const r=await receiveEquivalentBranch(client,{...args,apply:false});
 assert.equal(r.reason,"dry-run");
 assert.equal(r.received,false);
 assert.equal(r.fileCount,1);
 assert.ok(calls.every(x=>x.method==="GET"));
});

test("source-equivalent historical commits never become a merge or branch deletion",async()=>{
 const {client,calls,args}=fixture();
 const value=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(value.received,false);
 assert.equal(value.deleted,false);
 assert.equal(value.reason,"original-native-work-and-consumer-receiving-required");
 assert.deepEqual(calls,[],"write request must refuse before any provider call");
});

test("no automerge fallback exists even if GitHub auto-delete is disabled",async()=>{
 const {client,calls,args}=fixture({autoDelete:false});
 const result=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(result.deleted,false);
 assert.equal(result.received,false);
 assert.deepEqual(calls,[]);
});

test("unqualified historical equivalence remains source-only without writes",async()=>{
 for(const cfg of [{same:false},{changedMain:true},{protectedRef:true},{extraPR:true}]){
  const {client,calls,args}=fixture(cfg);
  const result=await receiveEquivalentBranch(client,{...args,apply:false});
  assert.equal(result.received,false);
  assert.equal(result.deleted,false);
  assert.ok(calls.every(x=>["GET","LIST"].includes(x.method)));
 }
});

test("no PR is created for original source byte equivalence",async()=>{
 const {client,calls,args}=fixture({mergeBlocked:true});
 const result=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(result.received,false);
 assert.equal(result.deleted,false);
 assert.deepEqual(calls,[],"no PR ever created for source-only relation");
});

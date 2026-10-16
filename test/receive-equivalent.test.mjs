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

test("equivalent unique history merges exactly once and confirms auto-delete",async()=>{
 const {client,calls,args}=fixture();
 const r=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(r.received,true);
 assert.equal(r.deleted,true);
 assert.equal(r.prNumber,42);
 assert.equal(r.mergeSha,"merge1");
 assert.deepEqual(calls.filter(x=>x.method==="POST").map(x=>x.body.head),["codex/old"]);
 assert.equal(calls.filter(x=>x.method==="PUT").length,1);
 assert.equal(calls.filter(x=>x.method==="DELETE").length,0);
});

test("when auto-delete is disabled, reverified containment permits safe retirement",async()=>{
 const {client,calls,args}=fixture({autoDelete:false});
 const r=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(r.received,true);
 assert.equal(r.deleted,true);
 assert.equal(calls.filter(x=>x.method==="DELETE").length,1);
});

test("non-equivalent files, changed main, protected branch or new PR refuse before any write",async()=>{
 for(const config of [
   {same:false},{changedMain:true},{protectedRef:true},{extraPR:true},
 ]){
   const {client,calls,args}=fixture(config);
   const r=await receiveEquivalentBranch(client,{...args,apply:true});
   assert.equal(r.received,false);
   assert.equal(r.deleted,false);
   assert.ok(calls.every(x=>["GET","LIST"].includes(x.method)));
 }
});

test("merge refusal closes the newly created PR rather than leaving one hung",async()=>{
 const {client,calls,args}=fixture({mergeBlocked:true});
 const r=await receiveEquivalentBranch(client,{...args,apply:true});
 assert.equal(r.received,false);
 assert.equal(r.deleted,false);
 assert.equal(r.prNumber,42);
 assert.ok(calls.some(x=>x.method==="PATCH" && x.body.state==="closed"));
 assert.ok(!calls.some(x=>x.method==="DELETE"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { observeArchiveRefSources } from "../src/archive-ref-observation.mjs";

const ROOT = "a".repeat(40);
const SOURCE = "b".repeat(40);
const ANNOTATION = "c".repeat(40);
const UNRELATED = "d".repeat(40);
const input = {
  repository: "561-group/561-group-services-section",
  repositoryId: 1424041234,
  observedBaseCommitId: ROOT,
  observedBaseRefName: "refs/heads/main"
};
const ref = (name,type,sha) => ({ref:"refs/tags/archive/"+name,object:{type,sha}});
const path="/repos/561-group/561-group-services-section";

function provider(routes) {
  const calls=[];
  const client={async request(method,url){
    calls.push([method,url]);
    assert.equal(method,"GET","no writes permitted, even with misnamed archive tags");
    if(!Object.hasOwn(routes,url) && url===path+"/git/ref/heads/main")
      return {ref:"refs/heads/main",object:{type:"commit",sha:ROOT}};
    if(!Object.hasOwn(routes,url))throw new Error("unobserved source "+url);
    return structuredClone(typeof routes[url] === "function" ? routes[url]() : routes[url]);
  }};
  return {client,calls};
}

test("real GitHub lightweight and annotated archive refs retain both native object and peeled source",async()=>{
  const routes={
    [path+"/git/matching-refs/tags/archive/"]:[
      ref("fix/board-work","tag",ANNOTATION),
      ref("ops/original","commit",SOURCE)
    ],
    [path+"/git/tags/"+ANNOTATION]:{
      sha:ANNOTATION,tag:"archive/fix/board-work",object:{type:"commit",sha:UNRELATED},
      message:"AI agent says ARCHIVED AND MERGED; not actual acceptance"
    },
    [path+"/compare/"+ROOT+"..."+SOURCE]:{ahead_by:0,behind_by:12,status:"behind"},
    [path+"/compare/"+ROOT+"..."+UNRELATED]:{ahead_by:3,behind_by:75,status:"diverged"}
  };
  const {client,calls}=provider(routes);
  const result=await observeArchiveRefSources(client,input);
  assert.equal(result.length,2);
  assert.equal(result[0].refName,"refs/tags/archive/fix/board-work");
  assert.equal(result[0].gitObjectKind,"tag");
  assert.equal(result[0].gitObjectId,ANNOTATION);
  assert.equal(result[0].peeledCommitId,UNRELATED);
  assert.equal(result[0].technicalRelation,"divergent-source-history");
  assert.deepEqual([result[0].aheadCommitCount,result[0].behindCommitCount],[3,75]);
  assert.equal(result[1].refName,"refs/tags/archive/ops/original");
  assert.equal(result[1].gitObjectId,SOURCE);
  assert.equal(result[1].peeledCommitId,SOURCE);
  assert.equal(result[1].technicalRelation,"source-history-contained-in-base");
  for(const observed of result){
    assert.equal(observed.recordKind,"github.archive-ref-source-observation/v1");
    assert.equal(observed.repositoryId,input.repositoryId);
    assert.equal(observed.observedBaseCommitId,ROOT);
    assert.equal(observed.originalIssueReceiving,"not-observed");
    assert.equal(observed.originalConsumerReceiving,"not-observed");
    assert.equal(observed.automaticRefRetirementAllowed,false);
    assert.equal(observed.independentReceivingRequired,true);
    assert.ok(Object.isFrozen(observed));
  }
  assert.ok(Object.isFrozen(result));
  assert.equal(calls.length,6,"two archive inventories plus one default ref readback");
  assert.ok(!JSON.stringify(result).includes("AI agent says ARCHIVED"),
    "opaque tag messages are not acceptance/Work evidence");
});

test("nested or noncommit tags remain source evidence, never counterfeit a peeled Git commit",async()=>{
  const tag1="1".repeat(40),tag2="2".repeat(40),blob="3".repeat(40);
  const routes={
    [path+"/git/matching-refs/tags/archive/"]:[ref("historic-tree","tag",tag1)],
    [path+"/git/tags/"+tag1]:{sha:tag1,tag:"archive/historic-tree",object:{type:"tag",sha:tag2}},
    [path+"/git/tags/"+tag2]:{sha:tag2,tag:"inner",object:{type:"blob",sha:blob}}
  };
  const {client,calls}=provider(routes);
  const out=await observeArchiveRefSources(client,input);
  assert.equal(out[0].gitObjectId,tag1);
  assert.equal(out[0].peeledCommitId,null);
  assert.equal(out[0].technicalRelation,"noncommit-or-unpeeled-ref");
  assert.equal(out[0].aheadCommitCount,null);
  assert.equal(calls.length,5,"noncommit requires second inventory and base readback, never comparison");
});

test("never silently accept a partial or malformed GitHub ref inventory",async()=>{
  const valid=ref("one","commit",SOURCE);
  const badSources=[
    [valid,valid],
    [ref("..","commit",SOURCE)],
    [ref(".hidden","commit",SOURCE)],
    [ref("malformed/","commit",SOURCE)],
    [ref("ref.lock","commit",SOURCE)],
    [ref("one","commit","not-a-sha")],
    [ref("one","unknown",SOURCE)],
    [{ref:"refs/heads/one",object:{type:"commit",sha:SOURCE}}],
    new Array(129).fill(valid)
  ];
  for(const value of badSources){
    const {client,calls}=provider({[path+"/git/matching-refs/tags/archive/"]:value});
    await assert.rejects(observeArchiveRefSources(client,input));
    assert.ok(calls.length<=1,
      "invalid ref inventory must refuse before any commit comparison");
  }
  const wrongEnvelope=provider({[path+"/git/matching-refs/tags/archive/"]:{items:[]}});
  await assert.rejects(observeArchiveRefSources(wrongEnvelope.client,input),/incomplete/u);
});

test("an annotated tag must truly peel through its exact native tag SHA and label",async()=>{
  const base={[path+"/git/matching-refs/tags/archive/"]:[ref("important-work","tag",ANNOTATION)]};
  for(const invalid of [
    {sha:"f".repeat(40),tag:"archive/important-work",object:{type:"commit",sha:SOURCE}},
    {sha:ANNOTATION,tag:"archive/not-important-work",object:{type:"commit",sha:SOURCE}},
    {sha:ANNOTATION,tag:"archive/important-work",object:{type:"commit",sha:"short"}},
  ]){
    const {client}=provider({...base,[path+"/git/tags/"+ANNOTATION]:invalid});
    await assert.rejects(observeArchiveRefSources(client,input),/tag readback identity/u);
  }
});

test("unavailable comparison and incomplete provider permissions never produce an accepted source inventory",async()=>{
  const cases=[
    {[path+"/git/matching-refs/tags/archive/"]:[ref("history","commit",SOURCE)]},
    {[path+"/git/matching-refs/tags/archive/"]:[ref("history","commit",SOURCE)],
      [path+"/compare/"+ROOT+"..."+SOURCE]:{ahead_by:null,behind_by:3}},
  ];
  for(const routes of cases){
    const {client}=provider(routes);
    await assert.rejects(observeArchiveRefSources(client,input));
  }
  for(const malformed of [
    {...input,repositoryId:null},
    {...input,observedBaseCommitId:"main"},
    {...input,repository:"../attacker"},
    {...input,maxRefs:0},
    {...input,observedBaseRefName:"refs/tags/not-a-branch"}
  ]){
    const {client,calls}=provider({});
    await assert.rejects(observeArchiveRefSources(client,malformed));
    assert.equal(calls.length,0,"invalid source scope never calls GitHub");
  }
});

test("archive ref inventory must not change during exact source observation",async()=>{
  let reads=0;
  const routes={
    [path+"/git/matching-refs/tags/archive/"]:()=>++reads===1
      ?[ref("unprocessed","commit",SOURCE)]
      :[ref("unprocessed","commit",UNRELATED)],
    [path+"/compare/"+ROOT+"..."+SOURCE]:{ahead_by:2,behind_by:1}
  };
  const {client,calls}=provider(routes);
  await assert.rejects(observeArchiveRefSources(client,input),/ref identities changed/u);
  assert.equal(reads,2);
  assert.ok(calls.every(([method])=>method==="GET"));
});

test("even an empty tag census rejects changed default branch",async()=>{
  const routes={
    [path+"/git/matching-refs/tags/archive/"]:[],
    [path+"/git/ref/heads/main"]:{ref:"refs/heads/main",object:{type:"commit",sha:SOURCE}}
  };
  const {client,calls}=provider(routes);
  await assert.rejects(observeArchiveRefSources(client,input),/default branch changed/u);
  assert.equal(calls.filter(([,url])=>url===path+"/git/matching-refs/tags/archive/").length,2);
  assert.equal(calls.at(-1)[1],path+"/git/ref/heads/main");
});

test("two complete empty inventories and unchanged Git base really produce an empty census",async()=>{
  const routes={[path+"/git/matching-refs/tags/archive/"]:[]};
  const {client,calls}=provider(routes);
  assert.deepEqual(await observeArchiveRefSources(client,input),[]);
  assert.equal(calls.length,3);
});

test("deep annotated tag chains refuse instead of pretending the source is a noncommit object",async()=>{
  const ids="123456".split("").map(x=>x.repeat(40));
  const routes={[path+"/git/matching-refs/tags/archive/"]:[ref("deep","tag",ids[0])]};
  for(let i=0;i<5;i++)routes[path+"/git/tags/"+ids[i]]={
    sha:ids[i],tag:i===0?"archive/deep":"nested-"+i,object:{type:"tag",sha:ids[i+1]}
  };
  const {client}=provider(routes);
  await assert.rejects(observeArchiveRefSources(client,input),/chain exceeds bounded/u);
});

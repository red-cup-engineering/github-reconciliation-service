import test from "node:test";
import assert from "node:assert/strict";
import { branchContentEquivalence } from "../src/equivalent-branch.mjs";

function fixture(changes={}, readOverrides={}) {
 const reads=[];
 const body={
  "/repos/o/r/contents/src/a.mjs?ref=main":{sha:"s1",type:"file"},
  "/repos/o/r/contents/src/a.mjs?ref=feature%2Fnew":{sha:"s1",type:"file"},
  "/repos/o/r/contents/lib/module?ref=main":{sha:"c1",type:"submodule"},
  "/repos/o/r/contents/lib/module?ref=feature%2Fnew":{sha:"c1",type:"submodule"},
  ...readOverrides,
 };
 return {reads,client:{async request(method,url){
   reads.push(method+" "+url);
   if(method!=="GET"||!(url in body))throw new Error("unreadable "+url);
   return body[url];
 }},compare:{
   ahead_by:1,too_large:false,
   files:[{filename:"src/a.mjs",status:"modified"},
     {filename:"lib/module",status:"added"}],
   ...changes,
 }};
}

test("fully received ordinary blobs and Gitlink changes are individually witnessed",async()=>{
 const {client,compare,reads}=fixture();
 const result=await branchContentEquivalence(client,"o/r","main","feature/new",compare);
 assert.equal(result.equivalent,true);
 assert.deepEqual(result.examined,[
   {filename:"src/a.mjs",sha:"s1",type:"file"},
   {filename:"lib/module",sha:"c1",type:"submodule"},
 ]);
 assert.equal(reads.length,4);
});

test("squash PR or unique commit alone never proves files received",async()=>{
 for(const changes of [
  {ahead_by:0},{ahead_by:null},{too_large:true},
  {files:[]},
  {files:[{filename:"src/a.mjs",status:"removed"}]},
  {files:[{filename:"src/a.mjs",status:"renamed",previous_filename:"src/old.mjs"}]},
  {files:Array.from({length:300},(_,i)=>({filename:"x"+i,status:"added"}))},
 ]){
  const {client,compare,reads}=fixture(changes);
  const r=await branchContentEquivalence(client,"o/r","main","feature/new",compare);
  assert.equal(r.equivalent,false);
  assert.equal(reads.length,0);
 }
});

test("a mismatched or uninspectable blob never becomes an equivalence receipt",async()=>{
 for(const override of [
   {"/repos/o/r/contents/src/a.mjs?ref=main":{sha:"DIFF",type:"file"}},
   {"/repos/o/r/contents/src/a.mjs?ref=main":{sha:"s1",type:"symlink"}},
   {"/repos/o/r/contents/src/a.mjs?ref=main":[]},
   {"/repos/o/r/contents/src/a.mjs?ref=main":null},
 ]){
  const {client,compare}=fixture({},override);
  const r=await branchContentEquivalence(client,"o/r","main","feature/new",compare);
  assert.equal(r.equivalent,false);
  assert.ok(r.reason);
 }
 const {client,compare}=fixture();
 const r=await branchContentEquivalence(client,"o/r","main","missing",compare);
 assert.equal(r.reason,"content-unavailable");
});

test("bounded file limits cannot be relaxed to incomplete GitHub compare pages",async()=>{
 const {client,compare}=fixture();
 for(const maxFiles of [0,300,NaN,-1]) {
  let threw=false;
  try{await branchContentEquivalence(client,"o/r","main","feature/new",compare,{maxFiles})}
  catch(e){threw=/maxFiles/.test(e.message)}
  assert.equal(threw,true);
 }
 const capped=await branchContentEquivalence(client,"o/r","main","feature/new",compare,{maxFiles:1});
 assert.equal(capped.equivalent,false);
});

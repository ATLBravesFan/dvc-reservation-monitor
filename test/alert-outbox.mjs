import assert from "node:assert/strict";
import { enqueueOutbox,claimOutbox,markOutboxSent,markOutboxUncertain,requeueOutbox,quarantineExpiredSends } from "../src/alert-outbox.js";

// An in-memory D1 statement adapter exercises the SQL call paths and state transitions.
function fakeD1(){
 const rows=new Map();
 return {rows,prepare(sql){
   const args={};
   return {bind(...values){args.values=values;return this;},
     async run(){
       const v=args.values||[];
       if(sql.includes("INSERT OR IGNORE INTO alert_outbox")){
         if(rows.has(v[0]))return {meta:{changes:0}};
         rows.set(v[0],{key:v[0],status:"pending",attempts:0,payload:v[3]});return {meta:{changes:1}};
       }
       if(sql.includes("status='sending'")&&sql.includes("attempts=attempts+1")){
         const r=rows.get(v[2]);if(!r||r.status!=="pending"||(r.next&&r.next>v[3]))return {meta:{changes:0}};
         Object.assign(r,{status:"sending",until:v[0],attempts:r.attempts+1});return {meta:{changes:1}};
       }
       if(sql.includes("status='sent'")){const r=rows.get(v[2]);if(r?.status==="sending")r.status="sent";return {meta:{changes:1}};}
       if(sql.includes("status='uncertain'")&&!sql.includes("attempts>=?")){const r=rows.get(v[2]);if(r?.status==="sending")r.status="uncertain";return {meta:{changes:1}};}
       if(sql.includes("status='pending'")&&sql.includes("next_attempt_at=")&&sql.includes("attempts<?")){
         let n=0;for(const r of rows.values())if(r.status==="sending"&&r.until<=v[2]&&r.attempts<v[3]){r.status="pending";r.next=v[0];r.until=null;n++;}return {meta:{changes:n}};
       }
       if(sql.includes("status='uncertain'")&&sql.includes("attempts>=?")){
         let n=0;for(const r of rows.values())if(r.status==="sending"&&r.until<=v[1]&&r.attempts>=v[2]){r.status="uncertain";r.until=null;n++;}return {meta:{changes:n}};
       }
       if(sql.includes("status='pending'")&&sql.includes("next_attempt_at=")){const r=rows.get(v[3]);if(r?.status==="sending"){r.status="pending";r.next=v[1];}return {meta:{changes:1}};}
       throw Error("Unexpected SQL: "+sql);
     }};
 }};
}
const db=fakeD1();
const alert={key:"one",source:"dvc-shop",listingId:"R1",event:{type:"NEW",listing:{id:"R1"}},title:"Test"};
await enqueueOutbox(db,alert);
await enqueueOutbox(db,alert);
assert.equal(db.rows.size,1,"duplicate enqueue must be ignored");
const claims=await Promise.all([claimOutbox(db,"one"),claimOutbox(db,"one")]);
assert.deepEqual(claims.sort(),[false,true],"only one sender can claim");
await markOutboxSent(db,"one");
assert.equal(db.rows.get("one").status,"sent");
assert.equal(await claimOutbox(db,"one"),false,"sent alerts cannot be reclaimed");

await enqueueOutbox(db,{...alert,key:"two"});
assert.equal(await claimOutbox(db,"two"),true);
await markOutboxUncertain(db,"two","timeout");
assert.equal(db.rows.get("two").status,"uncertain");
assert.equal(await claimOutbox(db,"two"),false,"explicitly ambiguous provider sends stay quarantined");

await enqueueOutbox(db,{...alert,key:"three"});
await claimOutbox(db,"three",-1);
await quarantineExpiredSends(db);
assert.equal(db.rows.get("three").status,"pending","first abandoned delivery claim must be retried");
assert.equal(await claimOutbox(db,"three",-1),true,"recovered alert can be reclaimed once");
await quarantineExpiredSends(db);
assert.equal(db.rows.get("three").status,"uncertain","second abandoned delivery claim is quarantined");

await enqueueOutbox(db,{...alert,key:"four"});
await claimOutbox(db,"four");
await requeueOutbox(db,"four","preflight failure",0);
assert.equal(await claimOutbox(db,"four"),true,"definite pre-send failures can retry");
console.log("Outbox state transition tests passed");

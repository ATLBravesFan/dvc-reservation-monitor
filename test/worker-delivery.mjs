import assert from "node:assert/strict";
import worker from "../src/index.js";

// Exercise the real authenticated Worker route and Brevo request construction
// with an in-memory D1 adapter. No real emails, secrets, or production writes.
const rows=new Map(), counters=new Map(), ledger=new Map(), leases=new Map();
let sends=0, providerStatus=201;
const realFetch=globalThis.fetch;
globalThis.fetch=async (url,opts)=>{
 assert.match(String(url),/api\.brevo\.com\/v3\/smtp\/email/);
 const payload=JSON.parse(opts.body);
 assert.equal(payload.to[0].email,"test@example.com");
 assert.match(payload.htmlContent,/Book this reservation/);
 sends++;
 return new Response(providerStatus===201?'{"messageId":"fake"}':'{"error":"busy"}',{status:providerStatus,headers:{"content-type":"application/json"}});
};
function db(){
 return {prepare(sql){let args=[];
 return {bind(...v){args=v;return this;},
 async first(){
  if(sql.includes("SELECT emails_sent"))return {emails_sent:counters.get(args[0])||0};
  if(sql.includes("SELECT status FROM alerts"))return ledger.get(args[0])||null;
  return null;
 },
 async all(){
  if(sql.includes("SELECT * FROM alert_outbox"))return {results:[...rows.values()].filter(r=>r.status==="pending"&&(!r.next_attempt_at||r.next_attempt_at<=args[0])).slice(0,args[1])};
  return {results:[]};
 },
 async run(){
  if(sql.includes("INSERT INTO execution_leases")){const [source,token,,expires]=args;if(leases.has(source)&&leases.get(source).expires>Date.now())return {meta:{changes:0}};leases.set(source,{token,expires:Date.parse(expires)});return {meta:{changes:1}};}
  if(sql.includes("INSERT INTO execution_history")||sql.includes("UPDATE execution_history"))return {meta:{changes:1}};
  if(sql.includes("DELETE FROM execution_leases")){const l=leases.get(args[0]);if(l?.token===args[1])leases.delete(args[0]);return {meta:{changes:1}};}
  if(sql.includes("INSERT OR IGNORE INTO alert_outbox")){
   if(rows.has(args[0]))return {meta:{changes:0}};
   rows.set(args[0],{alert_key:args[0],source:args[1],listing_id:args[2],payload:args[3],status:"pending",attempts:0,title:args[6],show_matches:args[7],priority:args[8]});return {meta:{changes:1}};
  }
  if(sql.includes("status='sending'")&&sql.includes("attempts=attempts+1")){
   const r=rows.get(args[2]);if(!r||r.status!=="pending")return {meta:{changes:0}};
   r.status="sending";r.attempts++;return {meta:{changes:1}};
  }
  if(sql.includes("status='sent'")&&sql.includes("provider_message_id")){
   const r=rows.get(args[2]);if(r?.status==="sending")r.status="sent";return {meta:{changes:1}};
  }
  if(sql.includes("status='uncertain'")){
   if(sql.includes("lease_until<=?"))return {meta:{changes:0}};
   const r=rows.get(args[2]);if(r?.status==="sending")r.status="uncertain";return {meta:{changes:1}};
  }
  if(sql.includes("status='pending'")&&sql.includes("next_attempt_at")){
   const r=rows.get(args[3]);if(r?.status==="sending"){r.status="pending";r.next_attempt_at=args[1];}return {meta:{changes:1}};
  }
  if(sql.includes("UPDATE alerts SET status='sent'"))return {meta:{changes:0}};
  if(sql.includes("INSERT INTO counters")){const day=args[0];counters.set(day,(counters.get(day)||0)+1);return {meta:{changes:1}};}
  if(sql.includes("INSERT INTO meta"))return {meta:{changes:1}};
  throw Error("Unmocked D1 SQL: "+sql.slice(0,100));
 }}; }};
}
const DB=db(),env={DB,ADMIN_TOKEN:"local-test-token",BREVO_API_KEY:"fake",EMAIL_TO:"test@example.com",EMAIL_FROM:"sender@example.com"};
async function drain(){
 const response=await worker.fetch(new Request("https://worker.invalid/run?mode=drain-outbox",{method:"POST",headers:{Authorization:"Bearer local-test-token"}}),env);
 assert.equal(response.status,200);
 return response.json();
}
function add(key){
 rows.set(key,{alert_key:key,source:"dvc-shop",listing_id:key,payload:JSON.stringify({type:"NEW",listing:{id:key,resort:"Test Resort",room:"Studio",bookingUrl:"https://example.com/book",nightly:180,total:180,checkIn:"2027-01-01",checkOut:"2027-01-02",nights:1}}),status:"pending",attempts:0,title:"DVC Shop",show_matches:1,priority:1});
}
try{
 add("first");
 await Promise.all([drain(),drain()]);
 assert.equal(sends,1,"competing Worker requests must send only once");
 assert.equal(rows.get("first").status,"sent");
 await drain();
 assert.equal(sends,1,"sent notification must not repeat");
 providerStatus=503;
 add("second");
 await drain();
 assert.equal(rows.get("second").status,"pending","explicit 503 is retryable");
 providerStatus=201;
 rows.get("second").next_attempt_at=null;
 await drain();
 assert.equal(rows.get("second").status,"sent");
 assert.equal(sends,3);
 console.log("Worker delivery integration tests passed");
}finally{globalThis.fetch=realFetch;}

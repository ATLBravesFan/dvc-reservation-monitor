import assert from "node:assert/strict";
import { boundedFetch } from "../src/bounded-fetch.js";
import { assertInventoryHealthy } from "../src/inventory-guard.js";

const originalFetch=globalThis.fetch;
const row=id=>({id,checkIn:"2027-01-01",checkOut:"2027-01-03",total:300});
const prior=Object.fromEntries(Array.from({length:100},(_,i)=>[String(i),row(String(i))]));
try {
  globalThis.fetch=async()=>{throw new TypeError("simulated network outage");};
  await assert.rejects(boundedFetch("https://example.invalid/reservations"),/simulated network outage/);
  globalThis.fetch=async()=>new Response("rate limited",{status:429});
  const throttled=await boundedFetch("https://example.invalid/reservations");
  assert.equal(throttled.status,429,"HTTP rate limit must not be converted to success");
  await throttled.text();
  globalThis.fetch=async()=>new Response("server unavailable",{status:503});
  const unavailable=await boundedFetch("https://example.invalid/reservations");
  assert.equal(unavailable.status,503,"HTTP server failure must be visible to caller");
  await unavailable.text();
  globalThis.fetch=async()=>new Response('{"data":[]}',{status:200});
  const empty=await boundedFetch("https://example.invalid/reservations");
  assert.deepEqual(await empty.json(),{data:[]},"HTTP success does not imply valid inventory");
  assert.throws(()=>assertInventoryHealthy(prior,[],"fault-test"),/collapse/,"empty result must not replace existing inventory");
  assert.throws(()=>assertInventoryHealthy(prior,[row("x"),row("x")],"fault-test"),/duplicate/);
  assert.throws(()=>assertInventoryHealthy(prior,[{...row("x"),total:-1}],"fault-test"),/invalid price/);
  assert.throws(()=>assertInventoryHealthy(prior,[{...row("x"),checkOut:"2026-01-01"}],"fault-test"),/invalid dates/);
  assert.doesNotThrow(()=>assertInventoryHealthy(prior,Array.from({length:25},(_,i)=>row(String(i))),"fault-test"),"legitimate inventory changes should not be rejected indiscriminately");
  console.log("Upstream and inventory fault-injection tests passed");
} finally {globalThis.fetch=originalFetch;}

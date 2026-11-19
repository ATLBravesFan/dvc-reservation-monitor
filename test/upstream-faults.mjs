import assert from "node:assert/strict";
import { boundedFetch } from "../src/bounded-fetch.js";
import { assertInventoryHealthy } from "../src/inventory-guard.js";
import worker from "../src/index.js";

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
  assert.throws(()=>assertInventoryHealthy(null,[row("x"),row("x")],"fault-test"),/duplicate/);
  assert.throws(()=>assertInventoryHealthy(null,[{...row("x"),total:-1}],"fault-test"),/invalid price/);
  assert.throws(()=>assertInventoryHealthy(null,[{...row("x"),checkOut:"2026-01-01"}],"fault-test"),/invalid dates/);
  assert.doesNotThrow(()=>assertInventoryHealthy(prior,Array.from({length:25},(_,i)=>row(String(i))),"fault-test"),"legitimate inventory changes should not be rejected indiscriminately");
  // Ingestion failures must remain HTTP 500 for the backup workflow, but
  // carry a useful JSON explanation rather than the generic Cloudflare page.
  const failedIngest = await worker.fetch(
    new Request("https://worker.test/ingest/dvc-rental-store-website", {
      method:"POST",
      headers:{Authorization:"Bearer test-token","Content-Type":"application/json"},
      body:JSON.stringify({listings:[{id:"a0fVJ000004NVSDYA4",resort:"Boardwalk",
        room:"Studio",checkIn:"2027-01-01",checkOut:"2027-01-03",nights:2,total:300}]}),
    }),
    {INGEST_TOKEN:"test-token",DB:{prepare(){throw new Error("simulated D1 ingestion failure");}}},
  );
  assert.equal(failedIngest.status,500,"D1 failure must not be acknowledged as successful");
  const ingestError = await failedIngest.json();
  assert.equal(ingestError.ok,false);
  assert.match(ingestError.error,/simulated D1 ingestion failure/);
  console.log("Upstream and inventory fault-injection tests passed");
} finally {globalThis.fetch=originalFetch;}

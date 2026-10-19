import assert from "node:assert/strict";
import { durationMinutes, normalizeTimingRecord, getAllWatchTimingReport } from "../src/all-watch-timing.js";

assert.equal(durationMinutes("2026-10-19T13:16:45.000Z","2026-10-19T13:22:04.000Z"),5.32);
assert.equal(durationMinutes("2026-10-19T13:23:00Z","2026-10-19T13:22:00Z"),null);
const shop=normalizeTimingRecord({
 source:"dvc-shop",listingId:"587543",eventType:"NEW",detectedAt:"2026-10-19T13:21:10Z",
 sentAt:"2026-10-19T13:22:04Z",status:"sent",
},{published_at:"2026-10-19T13:16:45Z",first_seen_at:"2026-10-19T13:21:00Z"});
assert.equal(shop.publicationToSendMinutes,5.32);
assert.equal(shop.detectionToSendMinutes,0.9);
assert.equal(shop.firstSeenAt,"2026-10-19T13:21:00.000Z");
const change=normalizeTimingRecord({
 source:"dvc-shop",listingId:"587543",eventType:"PRICE CHANGE",detectedAt:"2026-10-20T13:20:00Z",
 sentAt:"2026-10-20T13:21:00Z",status:"sent",
},{published_at:"2026-10-19T13:16:45Z"});
assert.equal(change.publicationToSendMinutes,null,"Repricings must never use original post date for latency");
assert.equal(normalizeTimingRecord({
 source:"davids",listingId:"D-1",eventType:"NEW",detectedAt:"2026-10-19T13:20:00Z",
 sentAt:"2026-10-19T13:21:00Z",status:"sent",
}).publicationAt,null,"Publication metadata must not be invented for other sites");

const outboxRows=[
 {source:"dvc-shop",listing_id:"587543",payload:JSON.stringify({type:"NEW"}),created_at:"2026-10-19T13:21:10Z",updated_at:"2026-10-19T13:22:04Z",status:"sent"},
 {source:"dvc-rental-store",listing_id:"a0f123",payload:JSON.stringify({type:"NEW"}),created_at:"2026-10-19T13:19:00Z",updated_at:"2026-10-19T13:20:00Z",status:"sent"},
 {source:"davids",listing_id:"10012345",payload:JSON.stringify({type:"PRICE CHANGE"}),created_at:"2026-10-19T13:17:00Z",updated_at:"2026-10-19T13:18:00Z",status:"sent"},
 {source:"dvc-rental",listing_id:"DVC10000",payload:JSON.stringify({type:"NEW"}),created_at:"2026-10-19T13:14:00Z",updated_at:"2026-10-19T13:16:00Z",status:"sent"},
];
const rareRows=[{source:"dvcreservations-rare-finds",listing_id:"RARE-23",created_at:"2026-10-19T13:10:00Z",sent_at:"2026-10-19T13:11:00Z",status:"sent"}];
let writes=0, queries=[];
const db = {
  prepare(sql) {
    queries.push(sql);
    return {
      bind(...args) {
        return {
          async all() {
            if (sql.includes("FROM alert_outbox")) {
              const filtered = sql.includes(" AND source = ?")
                ? outboxRows.filter(x => x.source === args[0]) : outboxRows;
              return { results: filtered };
            }
            if (sql.includes("FROM alerts WHERE")) return { results: rareRows };
            if (sql.includes("FROM dvc_shop_publication_audit")) {
              return { results: [{ listing_id: "587543",
                published_at: "2026-10-19T13:16:45Z",
                first_seen_at: "2026-10-19T13:21:00Z" }] };
            }
            throw new Error("Unexpected query: " + sql);
          },
          async run() {
            writes++;
            throw new Error("Timing audit must be read-only");
          },
        };
      },
    };
  },
};
const report=await getAllWatchTimingReport(db,{limit:30});
assert.equal(report.sampledEvents,5);
assert.equal(report.sources.length,5);
assert.equal(report.rows.find(x=>x.source==="dvc-shop").publicationToSendMinutes,5.32);
assert.equal(report.rows.find(x=>x.source==="davids").eventType,"PRICE CHANGE");
assert.equal(report.rows.find(x=>x.source==="dvcreservations-rare-finds").eventType,"NEW/CHANGE (not recorded)");
assert.equal(report.explanation.additionalWebsiteRequests,0);
assert.equal(report.explanation.additionalEmails,0);
assert.equal(writes,0);
const filtered=await getAllWatchTimingReport(db,{source:"dvc-shop",limit:10});
assert.equal(filtered.sources.length,1);
assert.equal(filtered.rows.length,1);
assert.equal(filtered.rows[0].source,"dvc-shop");
assert.ok(!queries.at(-2).includes("FROM alerts WHERE"),"Filtered DVC Shop report must not read Rare Finds");
await assert.rejects(()=>getAllWatchTimingReport(db,{source:"not-a-site"}),/Unknown timing audit source/);
console.log("All-watch timing report tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePublicationPosts, evaluateDvcShopPublication,
  recordDvcShopObservations, recordDvcShopAlertSends,
} from "../src/dvc-shop-publication-audit.js";

const raw = [
  {id:587401,date_gmt:"2026-10-18T20:40:07",status:"publish"},
  {id:587403,date_gmt:"2026-10-18T20:41:03",status:"publish"},
  {id:587405,date_gmt:"2026-10-18T20:41:37",status:"publish"},
];
const posts=parsePublicationPosts(raw);
assert.equal(posts.length,3);
assert.deepEqual(posts[0],{id:"587401",publishedAt:"2026-10-18T20:40:07.000Z"});
assert.throws(()=>parsePublicationPosts([]),/no reservation posts/);
assert.throws(()=>parsePublicationPosts([{id:"not-id",date_gmt:"bad"}]),/too few valid/);

const enabledAt="2026-10-18T20:00:00.000Z";
const post={published_at:"2026-10-18T20:40:07.000Z"};
const at=new Date("2026-10-18T21:01:00.000Z");
assert.equal(evaluateDvcShopPublication(post,{now:at,enabledAt}).state,"published-not-detected");
assert.equal(evaluateDvcShopPublication(post,{now:at,enabledAt,inSnapshot:true}).state,"seen-without-first-seen-time");
const seen={...post,first_seen_at:"2026-10-18T20:44:07.000Z",first_eligible_at:"2026-10-18T20:44:07.000Z"};
assert.equal(evaluateDvcShopPublication(seen,{now:at,enabledAt,currentlyAvailable:true,inSnapshot:true}).state,"unnotified");
assert.equal(evaluateDvcShopPublication(seen,{now:at,enabledAt,currentlyAvailable:false,inSnapshot:true}).state,"monitoring");
const notified={...seen,first_alert_sent_at:"2026-10-18T20:45:26.000Z"};
const evaluated=evaluateDvcShopPublication(notified,{now:at,enabledAt,currentlyAvailable:true,inSnapshot:true});
assert.equal(evaluated.state,"notified");
assert.equal(evaluated.detectionMinutes,4);
assert.equal(evaluated.notificationMinutes,5+19/60);
assert.equal(evaluateDvcShopPublication(post,{now:at,enabledAt:"2026-10-19T00:00:00.000Z"}).state,"historical");

// Confirm only new / newly available listings issue audit writes, not every
// listing in a ~500-row five-minute poll. This preserves free D1 write limits.
const writes=[];
const db={prepare(sql){return {bind(...params){return {async run(){writes.push({sql,params})}}}}}};
const rows=[
  {id:"587401",status:"Available"},
  {id:"587403",status:"Pending"},
  {id:"587405",status:"Available"},
  {id:"580000",status:"Available"},
];
const previous={
  "587401":{id:"587401",status:"Available"},
  "587405":{id:"587405",status:"Pending"},
  "580000":{id:"580000",status:"Available"},
};
const observed=await recordDvcShopObservations(db,rows,previous,new Date("2026-10-18T20:45:00Z"));
assert.deepEqual(observed,{firstSeen:1,firstAvailable:1});
assert.equal(writes.length,2);
assert.equal(writes[0].params[0],"587403");
assert.equal(writes[0].params[2],null);
assert.equal(writes[1].params[0],"587405");
const baseline=await recordDvcShopObservations(db,rows,null);
assert.deepEqual(baseline,{firstSeen:0,firstAvailable:0});
assert.equal(writes.length,2);

await recordDvcShopAlertSends(db,[{type:"NEW",listing:{id:"587405"}}],new Date("2026-10-18T20:46:00Z"));
assert.equal(writes.length,3);
assert.deepEqual(writes[2].params.slice(0,3),["587405","2026-10-18T20:46:00.000Z","2026-10-18T20:46:00.000Z"]);
// Regression guard: first-sighting must be attached to the DVC Shop's
// standard watch; it must never be accidentally added to Rental Store polling.
const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const fastBlock = indexSource.split("async function processRentalStoreFast(env, store, rows) {")[1]
  .split("async function processRentalStoreAllWatch")[0];
const standardBlock = indexSource.split("async function processStandardWatch(env, store, key, watch, rows) {")[1]
  .split("async function sendEvents")[0];
assert.ok(standardBlock.includes("await recordDvcShopObservations(env.DB, rows, previous);"));
assert.ok(!fastBlock.includes("recordDvcShopObservations"));

console.log("DVC Shop publication audit tests passed");

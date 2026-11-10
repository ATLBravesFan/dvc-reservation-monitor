import assert from "node:assert/strict";
import worker from "../src/index.js";
import { shouldDispatchDavidsBackup } from "../src/davids-backup-dispatch.js";
import { parseDavids } from "../src/parsers.js";

const now = new Date("2026-11-10T15:00:00Z");
const ago = minutes => new Date(now.getTime() - minutes * 60000).toISOString();
assert.equal(shouldDispatchDavidsBackup(null, now), true);
assert.equal(shouldDispatchDavidsBackup(ago(3), now), false);
assert.equal(shouldDispatchDavidsBackup(ago(4), now), true);

const sample = '<a href="/dvc-guests/confirmed-reservations-for-rent/10052397">Request Now</a> ' +
  'Oct 26, 2026 - Oct 29, 2026 3 nights Saratoga Springs Resort &amp; Spa One Bedroom - Standard Request Now ' +
  'Total Cost (Points): 90 Price Per Point: $16 Total Cost (USD): $1,440 Sleeps: 5';
assert.equal(parseDavids(sample).length, 1);

const env = { DB: {}, INGEST_TOKEN: "test-ingest-token" };
async function ingest(html, auth = "Bearer test-ingest-token") {
  return worker.fetch(new Request("https://worker.invalid/ingest/davids-backup", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ html }),
  }), env);
}
assert.equal((await ingest(sample, "Bearer wrong-token")).status, 401);
assert.equal((await ingest("")).status, 400);
assert.equal((await ingest("not a confirmed reservation page")).status, 422);
console.log("David's alternate-network authentication and parsing tests passed");

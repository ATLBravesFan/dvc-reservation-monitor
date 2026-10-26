import assert from "node:assert/strict";
import worker, { dvcRentalInventoryMatchesSnapshot } from "../src/index.js";

const original = [
  { id: "DVC100", resort: "Boardwalk", room: "Studio", checkIn: "2027-03-01",
    checkOut: "2027-03-06", nights: 5, total: 800, nightly: 160, points: 50,
    status: "Available", bookingUrl: "https://dvc-rental.com/deals/DVC100" },
  { id: "DVC200", resort: "Animal Kingdom Lodge", room: "1-Bedroom",
    checkIn: "2027-04-01", checkOut: "2027-04-05", nights: 4,
    total: 1200, nightly: 300, points: 75, status: "Available",
    bookingUrl: "https://dvc-rental.com/deals/DVC200" },
];
const snapshot = Object.fromEntries(original.map(row => [row.id, row]));
const changed = original.map((row, i) => i === 0 ? { ...row, total: 700, nightly: 140 } : row);

assert.equal(dvcRentalInventoryMatchesSnapshot(null, original), false);
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, original), true);
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, [...original].reverse()), true);
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, changed), false, "Price changes must ingest");
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot,
  original.map((row, i) => i ? row : { ...row, checkIn: "2027-03-02" })), false, "Dates must ingest");
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, original.slice(0, 1)), false, "Removals cannot be ignored");
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, [...original, original[0]]), false, "Duplicates cannot be ignored");
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, [{ ...original[0], id: "DVC999" }, original[1]]), false, "New IDs cannot be ignored");
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot,
  original.map((row, i) => i ? row : { ...row, status: "Unavailable" })), false, "Status changes must not be ignored");
// Browser/direct parsing may differ on the advertised per-point rate;
// only actual customer pricing determines a real repricing event.
assert.equal(dvcRentalInventoryMatchesSnapshot(snapshot, original.map(row => ({
  ...row, listedPointPrice: 999, pointPrice: 999, effectivePointPrice: row.total / row.points,
}))), true, "Non-price metadata changes must not be treated as price changes");

let leaseAcquisitionAttempts = 0;
let browserHealth = 0;
let currentSnapshot = snapshot;
let readNumber = 0;
let switchAfterFirstRead = false;
const db = {
  prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("SELECT payload FROM snapshots")) {
          readNumber++;
          return { payload: JSON.stringify(switchAfterFirstRead && readNumber > 1
            ? Object.fromEntries(changed.map(row => [row.id, row]))
            : currentSnapshot) };
        }
        if (sql.includes("SELECT consecutive_failures")) return { consecutive_failures: 0, last_success_at: null };
        throw Error("Unexpected .first query: " + sql);
      },
      async run() {
        if (sql.includes("INSERT INTO execution_leases")) {
          leaseAcquisitionAttempts++;
          return { meta: { changes: 0 } };
        }
        if (sql.includes("UPDATE execution_history")) return { meta: { changes: 0 } };
        if (sql.includes("INSERT INTO health")) {
          if (args[0] === "dvc-rental-browser-ingest") browserHealth++;
          return { meta: { changes: 1 } };
        }
        throw Error("Unexpected .run query: " + sql);
      },
    };
  },
};
const env = { DB: db, INGEST_TOKEN: "fake-test-token" };
async function ingest(listings) {
  const res = await worker.fetch(new Request("https://worker.test/ingest/dvc-rental", {
    method: "POST",
    headers: { Authorization: "Bearer fake-test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ listings }),
  }), env);
  return { status: res.status, body: await res.json() };
}
let response = await ingest(original);
assert.equal(response.status, 200, "Already-saved browser snapshot is a verified success");
assert.equal(response.body.alreadyCurrent, true);
assert.equal(leaseAcquisitionAttempts, 0, "Unchanged browser inventory must avoid a competing lease");

response = await ingest(changed);
assert.equal(response.status, 409, "Changed reservations must not be silently dropped");
assert.equal(response.body.reason, "already-running");
assert.equal(leaseAcquisitionAttempts, 1);

switchAfterFirstRead = true;
readNumber = 0;
response = await ingest(changed);
assert.equal(response.status, 200, "If the primary commits after initial read, the backup is safe to acknowledge");
assert.equal(response.body.alreadyCurrent, true);
assert.equal(leaseAcquisitionAttempts, 2);
assert.equal(browserHealth, 2, "Only verified, safe browser completions should advance health");
console.log("DVC-Rental idempotent browser ingestion tests passed");

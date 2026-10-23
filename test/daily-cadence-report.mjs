import assert from "node:assert/strict";
import { dailyCadenceReport, utcBoundary, nyDay, adjacentDay } from "../src/daily-cadence-report.js";

// Day boundaries must use the offset AT midnight, not the noon DST offset.
assert.equal(utcBoundary("2026-03-08").toISOString(), "2026-03-08T05:00:00.000Z");
assert.equal(utcBoundary("2026-03-09").toISOString(), "2026-03-09T04:00:00.000Z");
assert.equal(utcBoundary("2026-11-01").toISOString(), "2026-11-01T04:00:00.000Z");
assert.equal(utcBoundary("2026-11-02").toISOString(), "2026-11-02T05:00:00.000Z");
assert.equal(nyDay(new Date("2026-10-23T00:05:00Z")), "2026-10-22");
assert.equal(adjacentDay("2026-03-01", -1), "2026-02-28");

const calls = [];
function mockDb(rows) {
  return {
    prepare(sql) {
      assert.match(sql, /julianday\(started_at\)/);
      return {
        bind(start, end) {
          calls.push([start, end]);
          return {
            async all() {
              return { results: rows.filter(r => Date.parse(r.started_at) >= Date.parse(start) &&
                Date.parse(r.started_at) < Date.parse(end)) };
            },
          };
        },
      };
    },
  };
}

const rows = [
  { source: "rental-store-api", started_at: "2026-10-22T04:00:00Z", outcome: "success" },
  { source: "rental-store-api", started_at: "2026-10-22T04:01:00Z", outcome: "success" },
  { source: "rental-store-api", started_at: "2026-10-22T04:03:00Z", outcome: "failure" },
  { source: "rental-store-api", started_at: "2026-10-22T04:04:00Z", outcome: "success" },
  { source: "davids", started_at: "2026-10-22T04:02:00Z", outcome: "failure" },
  { source: "dvc-shop", started_at: "2026-10-22T04:02:00Z", outcome: "success" },
  { source: "dvc-rental", started_at: "2026-10-22T04:00:00Z", outcome: "success" },
  { source: "dvc-rental", started_at: "2026-10-22T04:20:00Z", outcome: "success" },
  { source: "dvc-rental", started_at: "2026-10-22T04:40:00Z", outcome: "success" },
  { source: "dvc-rental", started_at: "2026-10-22T05:00:00Z", outcome: "success" },
];
const report = await dailyCadenceReport(mockDb(rows), null, new Date("2026-10-23T12:00:00Z"));
assert.equal(report.day, "2026-10-22", "Default must be yesterday in New York, not two days ago");
assert.equal(report.windowStart, "2026-10-22T04:00:00.000Z");
assert.equal(report.windowEndExclusive, "2026-10-23T04:00:00.000Z");
const watch = source => report.watches.find(row => row.source === source);
assert.equal(watch("rental-store-api").successfulRuns, 3);
assert.equal(watch("rental-store-api").failedRuns, 1);
assert.equal(watch("rental-store-api").averageMinutes, 2);
assert.equal(watch("rental-store-api").longestGapMinutes, 3);
assert.equal(watch("davids").status, "no-successes", "A failed check is not an inaccessible source");
assert.equal(watch("dvc-shop").status, "insufficient-samples");
assert.equal(watch("rental-store-all").status, "no-executions");
assert.equal(watch("dvc-rental").status, "behind");
assert.equal(watch("dvc-rental").gapsAtLeast10MinutesLate, 3);
assert.equal(calls.length, 1);

const spring = await dailyCadenceReport(mockDb([]), "2026-03-08", new Date("2026-03-10T16:00:00Z"));
assert.equal(spring.hoursInCalendarDay, 23);
const fall = await dailyCadenceReport(mockDb([]), "2026-11-01", new Date("2026-11-03T16:00:00Z"));
assert.equal(fall.hoursInCalendarDay, 25);
await assert.rejects(() => dailyCadenceReport(mockDb([]), "2026-10-23", new Date("2026-10-23T12:00:00Z")), /completed/);
await assert.rejects(() => dailyCadenceReport({ prepare() { throw Error("D1 unavailable"); } }, null,
  new Date("2026-10-23T12:00:00Z")), /D1 unavailable/);
console.log("D1 daily cadence and DST tests passed");

import assert from "node:assert/strict";
import { RECOVERY_INTERVALS, recoveryGraceMinutes, isOverdue } from "../src/recovery-policy.js";

assert.deepEqual(RECOVERY_INTERVALS["rental-store-all"], [10, "rental-store-all"]);
assert.equal(recoveryGraceMinutes("rental-store-all"), 2);
assert.equal(recoveryGraceMinutes("dvcreservations-rare-finds"), 5);

const now = new Date("2026-10-23T12:00:00Z");
const ago = minutes => new Date(now.getTime() - minutes * 60000).toISOString();
assert.equal(isOverdue("rental-store-all", ago(11), now), false);
assert.equal(isOverdue("rental-store-all", ago(12), now), true);
assert.equal(isOverdue("rental-store-api", ago(2), now), false);
assert.equal(isOverdue("rental-store-api", ago(3), now), true);
assert.equal(isOverdue("dvc-shop", ago(7), now), false);
assert.equal(isOverdue("dvc-shop", ago(8), now), true);
assert.equal(isOverdue("davids", ago(8), now), true);
assert.equal(isOverdue("dvc-rental-direct", ago(8), now), true);
assert.equal(isOverdue("rental-store-website-dispatch", ago(8), now), true);
assert.equal(isOverdue("dvcreservations-rare-finds", ago(19), now), false);
assert.equal(isOverdue("dvcreservations-rare-finds", ago(20), now), true);
assert.equal(isOverdue("rental-store-all", null, now), true);
assert.throws(() => isOverdue("unknown", null, now), /Unknown/);
console.log("Source recovery policy tests passed");

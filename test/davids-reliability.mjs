import assert from "node:assert/strict";
import { DAVIDS_FIRST_TIMEOUT_MS, DAVIDS_RETRY_TIMEOUT_MS, isTransientDavidsFailure, withDavidsRetry, nextDavidsIncident } from "../src/davids-reliability.js";

const errorWithStatus = status => Object.assign(new Error("upstream " + status), { status });
const time = minutes => new Date(Date.parse("2026-11-09T12:00:00.000Z") + minutes * 60000).toISOString();
const step = (state, ok, minute, failures = 0) =>
  nextDavidsIncident(state, { ok, consecutiveFailures: failures, at: time(minute) });

assert.equal(isTransientDavidsFailure(errorWithStatus(522)), true);
assert.equal(isTransientDavidsFailure(errorWithStatus(503)), true);
assert.equal(isTransientDavidsFailure(new Error("HTTP timeout after 30000ms")), true);
assert.equal(isTransientDavidsFailure(new Error("The operation timed out")), true);
assert.equal(isTransientDavidsFailure(new Error("TimeoutError: timed out")), true);
assert.equal(isTransientDavidsFailure(errorWithStatus(404)), false);
assert.equal(isTransientDavidsFailure(errorWithStatus(429)), false, "do not hammer a rate-limited source");
assert.equal(isTransientDavidsFailure(new Error("parser returned zero reservations")), false);

let calls = [], sleeps = [];
const fetched = await withDavidsRetry(async timeout => {
  calls.push(timeout);
  if (calls.length === 1) throw errorWithStatus(522);
  return "valid inventory";
}, async ms => { sleeps.push(ms); });
assert.equal(fetched, "valid inventory");
assert.deepEqual(calls, [DAVIDS_FIRST_TIMEOUT_MS, DAVIDS_RETRY_TIMEOUT_MS]);
assert.deepEqual(sleeps, [700]);

calls = [];
await assert.rejects(
  withDavidsRetry(async timeout => { calls.push(timeout); throw errorWithStatus(522); }, async () => {}),
  /522/,
);
assert.equal(calls.length, 2, "never retry more than once per five-minute poll");

calls = [];
await assert.rejects(
  withDavidsRetry(async timeout => { calls.push(timeout); throw errorWithStatus(403); }, async () => {}),
  /403/,
);
assert.deepEqual(calls, [DAVIDS_FIRST_TIMEOUT_MS], "persistent rejection must not retry");

let incident = step(null, false, 0, 2);
assert.equal(incident.notification, null);
assert.equal(incident.changed, false);
incident = step(null, false, 5, 3);
assert.equal(incident.notification, "warning");
assert.equal(incident.state.active, true);
let state = incident.state;
incident = step(state, false, 10, 4);
assert.equal(incident.notification, null, "one outage creates one warning");
assert.equal(incident.changed, false);

incident = step(state, true, 15);
state = incident.state;
assert.equal(state.goodChecks, 1);
incident = step(state, true, 16);
assert.equal(incident.changed, false, "rapid manual polls cannot fake a stable recovery");
incident = step(state, false, 20, 1);
state = incident.state;
assert.equal(state.goodChecks, 0, "flapping resets recovery verification");
incident = step(state, false, 25, 2);
assert.equal(incident.notification, null);
incident = step(state, true, 30);
state = incident.state;
incident = step(state, true, 35);
state = incident.state;
incident = step(state, true, 40);
assert.equal(incident.notification, "recovery");
assert.equal(incident.state.active, false);
state = incident.state;

incident = step(state, false, 45, 3);
assert.equal(incident.notification, null, "do not warn again during six-hour flapping cooldown");
incident = step(state, false, 400, 4);
assert.equal(incident.notification, "warning", "a separate prolonged outage warrants warning");
incident = step(null, false, 0, 8);
assert.equal(incident.notification, null, "adopt pre-deployment outage without an immediate duplicate warning");
assert.equal(incident.state.active, true);

console.log("David's retry and incident regression tests passed");

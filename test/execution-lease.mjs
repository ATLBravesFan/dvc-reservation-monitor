import assert from "node:assert/strict";
import { acquireLease, releaseLease, withLease } from "../src/execution-lease.js";

// In-memory model of the atomic D1 lease statement, including expiry and token checks.
const leases = new Map();
const history = [];
let failHistory = false;
const db = { prepare(sql) {
  let args = [];
  return {
    bind(...values) { args = values; return this; },
    async run() {
      if (sql.includes("INSERT INTO execution_leases")) {
        const [source, token, acquired, expires] = args;
        const existing = leases.get(source);
        if (existing && existing.expires > acquired) return { meta: { changes: 0 } };
        leases.set(source, { token, expires });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("DELETE FROM execution_leases")) {
        const [source, token] = args;
        if (leases.get(source)?.token === token) leases.delete(source);
        return { meta: { changes: 1 } };
      }
      if (sql.includes("INSERT INTO execution_history")) {
        if (failHistory) throw Error("D1 history unavailable");
        history.push(args[1]);
        return { meta: { changes: 1 } };
      }
      if (sql.includes("UPDATE execution_history")) return { meta: { changes: 1 } };
      throw Error("Unexpected D1 SQL");
    },
  };
} };
const token = await acquireLease(db, "source", 90);
assert.ok(token);
assert.equal(await acquireLease(db, "source", 90), null, "active lease must prevent duplicate work");
await releaseLease(db, "source", "wrong-token");
assert.ok(leases.has("source"), "old owner cannot release current owner's lease");
leases.get("source").expires = new Date(Date.now() - 1000).toISOString();
const replacement = await acquireLease(db, "source", 90);
assert.ok(replacement && replacement !== token, "expired lease must be reclaimable");
await releaseLease(db, "source", token);
assert.ok(leases.has("source"), "expired owner cannot release replacement lease");
await releaseLease(db, "source", replacement);
assert.equal(leases.has("source"), false);
let executed = 0;
await Promise.all([withLease(db, "overlap", async () => {
  executed++;
  await new Promise(resolve => setTimeout(resolve, 15));
}), withLease(db, "overlap", async () => { executed++; })]);
assert.equal(executed, 1, "overlapping invocations must execute only once");
assert.equal(leases.has("overlap"), false);
await assert.rejects(withLease(db, "failure", async () => { throw Error("upstream timeout"); }), /upstream timeout/);
assert.equal(leases.has("failure"), false, "failed source must release its lease");
failHistory = true;
await assert.rejects(withLease(db, "history", async () => {}), /D1 history unavailable/);
assert.equal(leases.has("history"), false, "history write failure must release lease");
console.log("Execution lease fault-injection tests passed");

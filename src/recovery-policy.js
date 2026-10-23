// Source-specific overdue policy for the independent Cloudflare recovery loop.
// D1 execution leases still guard against overlapping source checks.
export const RECOVERY_INTERVALS = Object.freeze({
  "rental-store-api": [1, "rental-store"],
  "dvc-rental-direct": [5, "dvc-rental-direct"],
  "dvc-shop": [5, "dvc-shop"],
  "davids": [5, "davids"],
  "rental-store-all": [10, "rental-store-all"],
  "rental-store-website-dispatch": [5, "website-backup-dispatch"],
  "dvcreservations-rare-finds": [15, "rare-finds"],
});

const GRACE_MINUTES = Object.freeze({
  "rental-store-api": 2,
  "dvc-rental-direct": 3,
  "dvc-shop": 3,
  "davids": 3,
  "rental-store-all": 2,
  "rental-store-website-dispatch": 3,
  "dvcreservations-rare-finds": 5,
});

export function recoveryGraceMinutes(source) {
  return GRACE_MINUTES[source] ?? 10;
}

export function isOverdue(source, lastSuccessAt, now = new Date()) {
  const policy = RECOVERY_INTERVALS[source];
  if (!policy) throw new Error("Unknown recovery source: " + source);
  const last = Date.parse(lastSuccessAt || "");
  return !Number.isFinite(last) ||
    now.getTime() - last >= (policy[0] + recoveryGraceMinutes(source)) * 60000;
}

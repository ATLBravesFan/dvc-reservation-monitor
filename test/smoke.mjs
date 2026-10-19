import assert from "node:assert/strict";
import { WATCHES, EMAIL_LIMITS } from "../src/config.js";
import { normalizeBrowserRows } from "../src/index.js";
import { parseKeyholder, parseDavids, parseDvcShop, fingerprint, formatListing } from "../src/parsers.js";

assert.equal(WATCHES.rentalStoreNightly.match({ nightly: 200.99 }), true);
assert.equal(WATCHES.rentalStoreNightly.match({ nightly: 201.00 }), false);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 11.99 }), true);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 12.00 }), false);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 11.50, effectivePointPrice: 12.50 }), false);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 12.50, effectivePointPrice: 11.50 }), true);
assert.equal(WATCHES.rentalStoreAll.match({ nightly: 9999 }), true);
assert.equal(Object.values(WATCHES).every(watch => watch.priceChanges === true), true, "Every watch must alert on price changes");
assert.equal(WATCHES.davids.match({ nightly: 375.99, room: "Deluxe Studio", pointPrice: 24 }), true);
assert.equal(WATCHES.davids.match({ nightly: 376.00, room: "Deluxe Studio", pointPrice: 24 }), false);
assert.equal(WATCHES.davids.match({ nightly: 450, room: "Two Bedroom - Standard", pointPrice: 16.99 }), true);
assert.equal(WATCHES.davids.match({ nightly: 450, room: "Two Bedroom - Standard", pointPrice: 17.00 }), false);
assert.ok(EMAIL_LIMITS.warningAt < EMAIL_LIMITS.lowPriorityCutoff);
assert.ok(EMAIL_LIMITS.lowPriorityCutoff < EMAIL_LIMITS.hardSafetyCutoff);
assert.ok(EMAIL_LIMITS.hardSafetyCutoff < EMAIL_LIMITS.providerDaily);

const keyholder = parseKeyholder({ data: [{
  id: "a0fTEST123",
  resort: "Old Key West Villas",
  roomType: "Deluxe Studio",
  checkInString: "2027-01-01",
  checkOutString: "2027-01-05",
  price: 800,
  points: 80,
}] });
assert.equal(keyholder.length, 1);
assert.equal(keyholder[0].nights, 4);
assert.equal(keyholder[0].nightly, 200);
assert.equal(keyholder[0].effectivePointPrice, 10);
assert.equal(keyholder[0].pointPrice, 10);
assert.equal(keyholder[0].bookingUrl.endsWith("/a0fTEST123/"), true);
assert.ok(formatListing(keyholder[0]).includes("80 points"));
assert.ok(formatListing(keyholder[0]).includes("$10/point effective"));

// Older D1 snapshots did not contain the newer derived point-price fields.
// Adding parser fields must not make an unchanged reservation look changed.
const legacyKeyholder = { ...keyholder[0] };
delete legacyKeyholder.effectivePointPrice;
delete legacyKeyholder.listedPointPrice;
assert.equal(fingerprint(legacyKeyholder), fingerprint(keyholder[0]));

// Real user-visible changes must still change the fingerprint.
assert.notEqual(fingerprint({ ...keyholder[0], total: 760, nightly: 190 }), fingerprint(keyholder[0]));
assert.notEqual(fingerprint({ ...keyholder[0], checkOut: "2027-01-06", nights: 5 }), fingerprint(keyholder[0]));
assert.notEqual(fingerprint({ ...keyholder[0], room: "One Bedroom" }), fingerprint(keyholder[0]));

const davids = parseDavids(`
<a href="/dvc-guests/confirmed-reservations-for-rent/10052397">Request Now</a>
Oct 26, 2026 - Oct 29, 2026 3 nights
Saratoga Springs Resort &amp; Spa One Bedroom - Standard Request Now
Total Cost (Points): 90 Price Per Point: $16 Total Cost (USD): $1,440 Sleeps: 5
`);
assert.equal(davids.length, 1);
assert.equal(davids[0].id, "10052397");
assert.equal(davids[0].listedPointPrice, 16);
assert.equal(davids[0].effectivePointPrice, 16);
assert.equal(WATCHES.davids.match(davids[0]), true);

const dvcShop = parseDvcShop(`
<table><tr>
<td>12/01/2026</td><td>4</td><td>Saratoga Springs</td><td>Deluxe Studio</td><td>4</td><td>$800</td><td>Available</td>
<td><a href="https://rentals.dvcshop.com/product/confirmed-reservation/?post_id=584737">BOOK NOW #584737</a></td>
</tr></table>
`);
assert.equal(dvcShop.length, 1);
assert.equal(dvcShop[0].id, "584737");
assert.equal(dvcShop[0].nightly, 200);
assert.equal(WATCHES.dvcShop.match(dvcShop[0]), true);

// Browser fallback and direct DVC-Rental must preserve the same price fields.
const directDeal = {
  id: "DVC10016", resort: "Boardwalk Villas", room: "Deluxe Studio · Garden/Pool View",
  checkIn: "2026-12-15", checkOut: "2026-12-20", nights: 5,
  total: 2302.56, points: 82, nightly: 460.512,
  pointPrice: 28.08, listedPointPrice: 27, effectivePointPrice: 2302.56 / 82,
};
const [browserDeal] = normalizeBrowserRows([directDeal], "DVC-Rental");
assert.equal(browserDeal.listedPointPrice, 27);
assert.equal(fingerprint(directDeal), fingerprint(browserDeal), "Browser fallback must not invent price changes");

console.log("DVC monitor smoke tests passed");

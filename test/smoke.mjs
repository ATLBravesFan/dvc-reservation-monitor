import assert from "node:assert/strict";
import { WATCHES, EMAIL_LIMITS } from "../src/config.js";
import { parseKeyholder, parseDavids, parseDvcShop } from "../src/parsers.js";

assert.equal(WATCHES.rentalStoreNightly.match({ nightly: 200.99 }), true);
assert.equal(WATCHES.rentalStoreNightly.match({ nightly: 201.00 }), false);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 11.99 }), true);
assert.equal(WATCHES.rentalStorePoints.match({ pointPrice: 12.00 }), false);
assert.equal(WATCHES.rentalStoreAll.match({ nightly: 999 }), true);
assert.equal(WATCHES.rentalStoreAll.interval, "10 minutes");
assert.equal(WATCHES.davids.match({ nightly: 299.99, room: "Deluxe Studio", pointPrice: 24 }), true);
assert.equal(WATCHES.davids.match({ nightly: 300, room: "Deluxe Studio", pointPrice: 24 }), false);
assert.equal(WATCHES.davids.match({ nightly: 450, room: "Two Bedroom - Standard", pointPrice: 16.99 }), true);
assert.equal(WATCHES.davids.match({ nightly: 450, room: "Two Bedroom - Standard", pointPrice: 17.00 }), false);
assert.ok(EMAIL_LIMITS.warningAt < EMAIL_LIMITS.lowPriorityCutoff);
assert.ok(EMAIL_LIMITS.lowPriorityCutoff < EMAIL_LIMITS.hardSafetyCutoff);
assert.ok(EMAIL_LIMITS.hardSafetyCutoff < EMAIL_LIMITS.providerDaily);

const keyholder = parseKeyholder({
  data: [{
    id: "a0fTEST123",
    resort: "Old Key West Villas",
    roomType: "Deluxe Studio",
    checkInString: "2027-01-01",
    checkOutString: "2027-01-05",
    price: 800,
    points: 80,
    bookingUrl: "https://dvcrentalstore.com/guests/reservations/a0fTEST123/",
  }],
});
assert.equal(keyholder.length, 1);
assert.equal(keyholder[0].nights, 4);
assert.equal(keyholder[0].nightly, 200);
assert.equal(keyholder[0].pointPrice, 10);
assert.equal(keyholder[0].bookingUrl.endsWith("/a0fTEST123/"), true);

const davids = parseDavids(`
  <a href="/dvc-guests/confirmed-reservations-for-rent/10052397">Request Now</a>
  Oct 26, 2026 - Oct 29, 2026 3 nights
  Saratoga Springs Resort &amp; Spa One Bedroom - Standard Request Now
  Total Cost (Points): 90 Price Per Point: $16 Total Cost (USD): $1,440 Sleeps: 5
`);
assert.equal(davids.length, 1);
assert.equal(davids[0].id, "10052397");
assert.equal(davids[0].pointPrice, 16);
assert.equal(davids[0].nightly, 480);
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

console.log("DVC monitor smoke tests passed");

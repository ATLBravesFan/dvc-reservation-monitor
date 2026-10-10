import assert from "node:assert/strict";
import { WATCHES } from "../src/config.js";
import { parseRareFinds } from "../src/rare-finds.js";

const html = `
<html><body>
<h4>Rare Reservation Deals</h4>
<a href="hidden.php">reserve</a> | Animal Kingdom 11/18 to 11/20<br>
kidani studio<br>savanna view | $415 a night
<a href="hidden.php">reserve</a> | Animal Kingdom 7/15 to 7/17<br>
value studio | $175 a night
</body></html>`;

const rows = parseRareFinds(html, new Date("2026-10-10T12:00:00Z"));
assert.equal(rows.length, 2);

const november = rows.find(row => row.checkIn === "2026-11-18");
assert.ok(november);
assert.equal(november.checkOut, "2026-11-20");
assert.equal(november.nights, 2);
assert.equal(november.nightly, 415);
assert.equal(november.total, 830);
assert.equal(WATCHES.rentalStoreNightly.match(november), false);

const july = rows.find(row => row.checkIn === "2027-07-15");
assert.ok(july);
assert.equal(july.checkOut, "2027-07-17");
assert.equal(july.nights, 2);
assert.equal(july.nightly, 175);
assert.equal(july.total, 350);
assert.equal(WATCHES.rentalStoreNightly.match(july), true);
assert.equal(july.bookingUrl, "https://dvcreservations.com/rarefinds.php");

console.log("DVCReservations Rare Finds tests passed");

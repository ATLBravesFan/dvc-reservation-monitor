import assert from "node:assert/strict";
import { parseDvcRentalDealsHtml } from "../src/dvc-rental-direct.js";

const deals = [
  {
    id: "DVC10016",
    resort: "Boardwalk Villas",
    room_type: "Deluxe Studio",
    room_category: "Studio",
    view_type: "Garden/Pool View",
    check_in_date: "2026-12-15",
    check_out_date: "2026-12-20",
    nights_count: 5,
    total_points: 82,
    rental_price: 2302.56,
    price_per_point: 27,
    status: "available",
    pricing: { currentPrice: 2302.56 },
  },
  {
    id: "DVC9310",
    resort: "Saratoga Springs Resort",
    room_type: "Deluxe Studio",
    view_type: "Standard View",
    check_in_date: "2027-05-03",
    check_out_date: "2027-05-07",
    nights_count: 4,
    total_points: 48,
    rental_price: 1347.84,
    price_per_point: 27,
    status: "available",
  },
];

const rsc = `43:["$","section",null,{"children":["$","test",null,{"deals":${JSON.stringify(deals)}}]}]`;
const html = `<html><body><script>self.__next_f.push(${JSON.stringify([1, rsc])})</script></body></html>`;
const rows = parseDvcRentalDealsHtml(html);

assert.equal(rows.length, 2);
assert.equal(rows[0].id, "DVC10016");
assert.equal(rows[0].room, "Deluxe Studio · Garden/Pool View");
assert.equal(rows[0].points, 82);
assert.equal(rows[0].total, 2302.56);
assert.equal(rows[0].listedPointPrice, 27);
assert.equal(Math.round(rows[0].effectivePointPrice * 100) / 100, 28.08);
assert.equal(rows[0].bookingUrl, "https://dvc-rental.com/deals/DVC10016");
assert.equal(rows[1].id, "DVC9310");
assert.equal(rows[1].nights, 4);

console.log("DVC-Rental direct parser tests passed");

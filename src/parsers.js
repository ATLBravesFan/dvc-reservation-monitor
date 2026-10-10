import { URLS } from "./config.js";

export function parseKeyholder(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.results || payload?.reservations || payload?.items || []);
  return dedupe(rows.map(r => {
    const id = first(r.reservationID, r.reservationId, r.reservation_id, r.id, r.Id, r.sfid);
    const checkIn = iso(first(r.checkInString, r.checkIn, r.check_in, r.startDate, r.arrivalDate));
    const checkOut = iso(first(r.checkOutString, r.checkOut, r.check_out, r.endDate, r.departureDate));
    const nights = numFirst(r.nights, r.numberOfNights, r.number_of_nights, diffNights(checkIn, checkOut));
    const total = numFirst(r.price, r.totalPrice, r.total_price, r.total, r.totalCost, r.cost);
    const points = numFirst(r.points, r.totalPoints, r.total_points);
    const listedPointPrice = numFirst(r.pricePerPoint, r.pointPrice, r.price_per_point);
    return make({
      id,
      source: "DVC Rental Store",
      resort: first(r.resort, r.resortName, r.resort_name),
      room: first(r.roomType, r.room, r.roomName, r.room_type),
      checkIn,
      checkOut,
      nights,
      total,
      points,
      nightly: numFirst(r.pricePerNight, r.nightlyPrice, r.nightly, div(total, nights)),
      listedPointPrice,
      effectivePointPrice: div(total, points),
      pointPrice: numFirst(listedPointPrice, div(total, points)),
      status: first(r.status),
      bookingUrl: first(r.bookingUrl, r.bookingURL, r.url) || (id ? `https://dvcrentalstore.com/guests/reservations/${encodeURIComponent(id)}/` : null),
    });
  }));
}

export function parseExternalRentalStore(rows) {
  return dedupe((rows || []).map(r => {
    const id = first(r.id, r.reservationID, r.reservationId);
    const checkIn = iso(first(r.checkIn, r.checkInString));
    const checkOut = iso(first(r.checkOut, r.checkOutString));
    const nights = numFirst(r.nights, diffNights(checkIn, checkOut));
    const total = numFirst(r.total, r.price, r.totalPrice);
    const points = numFirst(r.points, r.totalPoints);
    const listedPointPrice = numFirst(r.listedPointPrice, r.pointPrice, r.pricePerPoint);
    return make({
      id,
      source: "DVC Rental Store",
      resort: r.resort,
      room: r.room || r.roomType,
      checkIn,
      checkOut,
      nights,
      total,
      points,
      nightly: numFirst(r.nightly, r.pricePerNight, div(total, nights)),
      listedPointPrice,
      effectivePointPrice: numFirst(r.effectivePointPrice, div(total, points)),
      pointPrice: numFirst(r.pointPrice, listedPointPrice, div(total, points)),
      status: r.status || "Available",
      bookingUrl: r.bookingUrl || (id ? `https://dvcrentalstore.com/guests/reservations/${encodeURIComponent(id)}/` : null),
    });
  }));
}

export function parseDavids(html) {
  const links = anchors(html).filter(a => /request\s*now/i.test(a.text)).map(a => abs(a.href, URLS.davids));
  const text = htmlText(html);
  const re = /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+(\d+)\s+nights?\s+(.+?)\s+Request\s+Now\s+Total\s+Cost\s*\(Points\):\s*([\d,]+)\s+Price\s+Per\s+Point:\s*\$([\d.]+)(?:\s+Image)?\s+Total\s+Cost\s*\(USD\):\s*\$([\d,.]+)\s+Sleeps:\s*(\d+)/gi;
  const out = [];
  let match;
  let index = 0;

  while ((match = re.exec(text))) {
    const [resort, room] = splitRoom(match[4]);
    const checkIn = iso(match[1]);
    const checkOut = iso(match[2]);
    const nights = num(match[3]);
    const points = num(match[5]);
    const listedPointPrice = num(match[6]);
    const total = num(match[7]);
    const bookingUrl = links[index++] || URLS.davids;
    const id = bookingUrl.match(/\/([0-9]{5,})(?:[/?#]|$)/)?.[1] ||
      bookingUrl.match(/(?:id|reservation|res)[=\/-]([A-Za-z0-9_-]+)/i)?.[1] ||
      `DAVIDS-${hash([checkIn, checkOut, resort, room, points].join("|"))}`;

    out.push(make({
      id,
      source: "David's",
      resort,
      room,
      checkIn,
      checkOut,
      nights,
      points,
      listedPointPrice,
      effectivePointPrice: div(total, points),
      pointPrice: listedPointPrice,
      total,
      nightly: div(total, nights),
      sleeps: num(match[8]),
      status: "Available",
      bookingUrl,
    }));
  }
  return dedupe(out);
}

export function parseDvcShop(html) {
  const out = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(strip(m[1])));
    if (cells.length < 7) continue;
    const id = (cells.join(" ").match(/#?(\d{5,})\b/) || row.match(/post_id=(\d+)/i))?.[1];
    if (!id) continue;
    const checkIn = iso(cells[0]);
    const nights = num(cells[1]);
    const total = num(cells[5]);
    const href = row.match(/href=["']([^"']*(?:post_id=\d+|confirmed-reservation)[^"']*)["']/i)?.[1];
    out.push(make({
      id,
      source: "DVC Shop",
      resort: cells[2],
      room: cells[3],
      checkIn,
      checkOut: addDays(checkIn, nights),
      nights,
      total,
      nightly: div(total, nights),
      sleeps: num(cells[4]),
      status: cells[6],
      bookingUrl: href ? abs(href, URLS.dvcShop) : `https://rentals.dvcshop.com/product/confirmed-reservation/?post_id=${id}`,
    }));
  }
  return dedupe(out);
}

export function fingerprint(r) {
  const total = numFirst(r?.total);
  const nights = numFirst(r?.nights, diffNights(r?.checkIn, r?.checkOut));
  const nightly = numFirst(r?.nightly, div(total, nights));
  const points = numFirst(r?.points);
  const effectivePointPrice = numFirst(r?.effectivePointPrice, div(total, points));
  const listedPointPrice = numFirst(r?.listedPointPrice, r?.pointPrice);

  // Keep this based on stable, user-visible reservation facts. Older D1
  // snapshots may not have newer derived fields such as effectivePointPrice
  // or listedPointPrice, so derive/fallback here instead of treating a parser
  // upgrade as hundreds of reservation changes.
  return [
    fingerprintText(r?.resort),
    fingerprintText(r?.room),
    iso(r?.checkIn) || clean(r?.checkIn),
    iso(r?.checkOut) || clean(r?.checkOut),
    round(nights),
    round(total),
    round(nightly),
    round(points),
    round(effectivePointPrice),
    round(listedPointPrice),
  ].join("|");
}

export function formatListing(r) {
  return [
    r.id,
    r.resort,
    r.room,
    r.checkIn && r.checkOut ? `${r.checkIn} → ${r.checkOut}` : r.checkIn,
    Number.isFinite(r.nights) ? `${r.nights} night${r.nights === 1 ? "" : "s"}` : null,
    Number.isFinite(r.nightly) ? `${money(r.nightly)}/night` : null,
    Number.isFinite(r.points) ? `${Math.round(r.points).toLocaleString("en-US")} points` : null,
    ...pointPriceParts(r),
    Number.isFinite(r.total) ? `${money(r.total)} total` : null,
  ].filter(Boolean).join(" | ");
}

export function priceSummary(r) {
  return [
    Number.isFinite(r.nightly) ? `${money(r.nightly)}/night` : null,
    Number.isFinite(r.points) ? `${Math.round(r.points).toLocaleString("en-US")} points` : null,
    ...pointPriceParts(r),
    Number.isFinite(r.total) ? `${money(r.total)} total` : null,
  ].filter(Boolean).join(" | ");
}

export function byId(rows) {
  return Object.fromEntries(rows.map(r => [String(r.id), r]));
}

function pointPriceParts(r) {
  const effective = numFirst(r.effectivePointPrice, div(r.total, r.points));
  const listed = numFirst(r.listedPointPrice, r.pointPrice);
  if (Number.isFinite(effective)) {
    const parts = [`${money(effective)}/point effective`];
    if (Number.isFinite(listed) && Math.abs(listed - effective) >= 0.01) {
      parts.push(`${money(listed)}/point site rate`);
    }
    return parts;
  }
  return Number.isFinite(listed) ? [`${money(listed)}/point`] : [];
}

function make(r) {
  r.resort = clean(r.resort);
  r.room = clean(r.room);
  if (!Number.isFinite(r.nightly)) r.nightly = div(r.total, r.nights);
  if (!Number.isFinite(r.effectivePointPrice)) r.effectivePointPrice = div(r.total, r.points);
  if (!Number.isFinite(r.listedPointPrice) && Number.isFinite(r.pointPrice)) r.listedPointPrice = r.pointPrice;
  if (!Number.isFinite(r.pointPrice)) r.pointPrice = numFirst(r.effectivePointPrice, r.listedPointPrice);
  return r?.id && (r.resort || r.room || r.checkIn) ? r : null;
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows.filter(Boolean)) map.set(String(row.id), row);
  return [...map.values()].sort((a, b) => String(a.checkIn || "").localeCompare(String(b.checkIn || "")) || String(a.id).localeCompare(String(b.id)));
}

function anchors(html) {
  const out = [];
  const re = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) out.push({ href: decode(match[2]), text: clean(strip(match[4])) });
  return out;
}

function htmlText(html) {
  return clean(decode(String(html).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")));
}

function strip(value = "") {
  return decode(String(value).replace(/<[^>]+>/g, " "));
}

function decode(value = "") {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rarr;|&#8594;/gi, "→")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function splitRoom(text = "") {
  const value = clean(text);
  const re = /\b(Deluxe\s+Studio|Resort\s+Studio|Tower\s*-?\s*(?:Deluxe|Duo)?\s*Studio|Duo\s+Studio|Studio\b|One\s+Bedroom|Two\s+Bedroom|Three\s+Bedroom|1[- ]Bedroom|2[- ]Bedroom|3[- ]Bedroom|Grand\s+Villa|Cabin|Bungalow|Treehouse\s+Villas?|Deluxe\s+Inn\s+Room)\b/i;
  const match = re.exec(value);
  return match ? [clean(value.slice(0, match.index)), clean(value.slice(match.index))] : [value, ""];
}

function first(...values) {
  for (const value of values) if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  return null;
}

function numFirst(...values) {
  for (const value of values) {
    const number = num(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function num(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function div(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b ? a / b : null;
}

function iso(value) {
  if (!value) return null;
  const text = String(value).trim();
  const exactIso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (exactIso) return exactIso[1];
  const mdY = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdY) return `${mdY[3]}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}`;
  const date = new Date(`${text} 12:00:00 UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function diffNights(a, b) {
  if (!a || !b) return null;
  const nights = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  return nights > 0 ? nights : null;
}

function addDays(a, nights) {
  if (!a || !Number.isFinite(nights)) return null;
  const date = new Date(`${a}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + nights);
  return date.toISOString().slice(0, 10);
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fingerprintText(value) {
  return clean(value).toLowerCase();
}

function abs(href, base) {
  try { return new URL(href, base).toString(); } catch { return href || base; }
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : "";
}

function money(value) {
  const number = round(value);
  return Number.isFinite(number) ? `$${number.toLocaleString("en-US", { minimumFractionDigits: number % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : "";
}

function hash(value) {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(36).toUpperCase();
}

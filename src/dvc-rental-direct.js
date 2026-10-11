export function parseDvcRentalDealsHtml(html) {
  const deals = [];
  const scripts = String(html || "").matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\((\[[\s\S]*?\])\)\s*<\/script>/gi);

  for (const match of scripts) {
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      continue;
    }

    const text = typeof payload?.[1] === "string" ? payload[1] : "";
    let searchFrom = 0;
    while (true) {
      const marker = text.indexOf('"deals":[', searchFrom);
      if (marker < 0) break;
      const arrayStart = marker + '"deals":'.length;
      const encoded = extractBalancedArray(text, arrayStart);
      if (!encoded) break;
      try {
        const parsed = JSON.parse(encoded);
        if (Array.isArray(parsed)) deals.push(...parsed);
      } catch {
        // Ignore malformed RSC fragments. A later completeness check prevents
        // a bad parse from replacing the last known-good snapshot.
      }
      searchFrom = arrayStart + encoded.length;
    }
  }

  const map = new Map();
  for (const deal of deals) {
    const row = normalizeDeal(deal);
    if (row) map.set(row.id, row);
  }
  return [...map.values()].sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)) || a.id.localeCompare(b.id));
}

function normalizeDeal(deal) {
  const id = String(deal?.id || "").trim().toUpperCase();
  if (!/^DVC\d+$/.test(id)) return null;

  const total = finite(deal?.rental_price, deal?.pricing?.currentPrice);
  const points = finite(deal?.total_points);
  const nights = finite(deal?.nights_count);
  const listedPointPrice = finite(deal?.price_per_point);
  const roomType = clean(deal?.room_type);
  const viewType = clean(deal?.view_type);
  const room = [roomType, viewType].filter(Boolean).join(" · ");

  return {
    id,
    source: "DVC-Rental",
    resort: clean(deal?.resort),
    room,
    checkIn: dateOnly(deal?.check_in_date),
    checkOut: dateOnly(deal?.check_out_date),
    nights,
    total,
    points,
    nightly: divide(total, nights),
    listedPointPrice,
    effectivePointPrice: divide(total, points),
    pointPrice: divide(total, points) ?? listedPointPrice,
    status: clean(deal?.status) || "Available",
    bookingUrl: `https://dvc-rental.com/deals/${encodeURIComponent(id)}`,
  };
}

function extractBalancedArray(text, start) {
  if (text[start] !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function finite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function divide(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b ? a / b : null;
}

function dateOnly(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "$undefined" ? "" : text;
}

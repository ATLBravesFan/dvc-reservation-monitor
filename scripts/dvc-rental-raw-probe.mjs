import { writeFile } from "node:fs/promises";

const url = "https://dvc-rental.com/deals";
const response = await fetch(url, {
  headers: {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "Mozilla/5.0 (compatible; DVC-Monitor-ReadOnly-Probe/1.0)",
  },
});
const html = await response.text();
await writeFile("dvc-rental-raw.html", html);

const ids = [...new Set([...html.matchAll(/\bDVC\d+\b/gi)].map(m => m[0].toUpperCase()))];
const reported = Number(html.match(/(\d+)\s+confirmed reservations/i)?.[1] || NaN);
console.log("\n===== DVC-RENTAL RAW HTTP PROBE =====");
console.log(`HTTP ${response.status} content-type=${response.headers.get("content-type") || ""} bytes=${html.length}`);
console.log(`Reported count in raw response: ${Number.isFinite(reported) ? reported : "unknown"}`);
console.log(`Distinct DVC IDs in raw response: ${ids.length}`);
console.log(`IDs: ${ids.join(", ")}`);

for (const id of ids.slice(-10)) {
  const index = html.indexOf(id);
  if (index < 0) continue;
  const snippet = html.slice(Math.max(0, index - 500), Math.min(html.length, index + 1200)).replace(/\s+/g, " ");
  console.log(`\nSNIPPET ${id}: ${snippet}`);
}

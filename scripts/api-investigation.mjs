import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-US",
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

try {
  await inspectDvcRental(context);
  await inspectDvcShop(context);
} finally {
  await browser.close();
}

async function inspectDvcRental(context) {
  console.log("\n===== DVC-RENTAL INVESTIGATION =====");
  const page = await context.newPage();
  const events = [];
  attachNetworkCapture(page, events);

  await page.goto("https://dvc-rental.com/deals", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  const body = await page.locator("body").innerText();
  const expected = Number(body.match(/(\d+)\s+confirmed reservations/i)?.[1] || NaN);
  const content = await page.content();
  const sourceIds = uniqueMatches(content, /\bDVC\d+\b/gi);
  const anchorIds = await page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => [...new Set(anchors.map(a => (a.href.match(/\bDVC\d+\b/i)?.[0] || "").toUpperCase()).filter(Boolean))]);

  console.log(`Reported total: ${Number.isFinite(expected) ? expected : "unknown"}`);
  console.log(`Distinct DVC IDs present in initial HTML/source: ${sourceIds.length}`);
  console.log(`Distinct reservation anchors in initial DOM: ${anchorIds.length}`);
  console.log(`Initial source IDs sample: ${sourceIds.slice(0, 8).join(", ")}`);

  const beforeClick = events.length;
  const pageTwo = page.getByRole("button", { name: /^2$/ }).last();
  if (await pageTwo.count()) {
    await pageTwo.click();
    await page.waitForTimeout(2500);
    const page2Ids = await page.locator('a[href*="/deals/DVC"]').evaluateAll(anchors => [...new Set(anchors.map(a => (a.href.match(/\bDVC\d+\b/i)?.[0] || "").toUpperCase()).filter(Boolean))]);
    console.log(`Page-2 DOM reservation IDs: ${page2Ids.length}`);
    console.log(`Page-2 sample: ${page2Ids.slice(0, 8).join(", ")}`);
    console.log("Network activity caused by clicking page 2:");
    printEvents(events.slice(beforeClick));
  } else {
    console.log("No page-2 button found.");
  }

  console.log("Interesting DVC-Rental requests seen during load:");
  printEvents(events);

  const perf = await page.evaluate(() => performance.getEntriesByType("resource").map(e => e.name));
  const interestingPerf = [...new Set(perf.filter(url => /api|graphql|json|deal|reservation|search|query/i.test(url)))];
  console.log("Interesting browser performance resources:");
  for (const url of interestingPerf.slice(0, 80)) console.log(`PERF ${url}`);

  if (anchorIds.length) {
    const detailUrl = `https://dvc-rental.com/deals/${anchorIds[0]}`;
    const response = await context.request.get(detailUrl, { timeout: 30000 });
    const text = await response.text();
    const points = textToPlain(text).match(/\b(\d[\d,]*)\s+points\b/i)?.[1] || "not found";
    const pointRate = textToPlain(text).match(/\$\s*([\d,.]+)\s*\/\s*pt\b/i)?.[1] || "not found";
    console.log(`Direct detail fetch ${detailUrl}: HTTP ${response.status()}, points=${points}, $/pt=${pointRate}, bytes=${text.length}`);
  }

  await page.close();
}

async function inspectDvcShop(context) {
  console.log("\n===== DVC SHOP INVESTIGATION =====");
  const page = await context.newPage();
  const events = [];
  attachNetworkCapture(page, events);

  await page.goto("https://rentals.dvcshop.com/confirmed-reservations/", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);

  const shopIds = await page.locator('a[href*="post_id="]').evaluateAll(anchors => [...new Set(anchors.map(a => new URL(a.href).searchParams.get("post_id")).filter(Boolean))]);
  const html = await page.content();
  const htmlIds = uniqueMatches(html, /post_id=(\d+)/gi, 1);
  console.log(`Confirmed-reservation IDs in DOM: ${shopIds.length}`);
  console.log(`Confirmed-reservation IDs in HTML/source: ${htmlIds.length}`);
  console.log(`Reservation ID sample: ${shopIds.slice(0, 8).join(", ")}`);

  console.log("Interesting DVC Shop requests seen during load:");
  printEvents(events);

  await testWooStoreApi(context, shopIds);
  await page.close();
}

async function testWooStoreApi(context, reservationIds) {
  const base = "https://rentals.dvcshop.com/wp-json/wc/store/v1/products";
  let pageNumber = 1;
  const products = [];
  let totalPages = 1;
  let totalProducts = null;

  try {
    do {
      const url = `${base}?per_page=100&page=${pageNumber}&orderby=date&order=desc`;
      const response = await context.request.get(url, { timeout: 30000, headers: { Accept: "application/json" } });
      const body = await response.text();
      console.log(`Woo Store API page ${pageNumber}: HTTP ${response.status()}, type=${response.headers()["content-type"] || ""}, bytes=${body.length}`);
      if (!response.ok()) {
        console.log(`Woo Store API body: ${body.slice(0, 500).replace(/\s+/g, " ")}`);
        return;
      }
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        console.log("Woo Store API did not return an array.");
        return;
      }
      products.push(...parsed);
      totalPages = Number(response.headers()["x-wp-totalpages"] || 1);
      totalProducts = Number(response.headers()["x-wp-total"] || parsed.length);
      pageNumber += 1;
      if (pageNumber > 20) break;
    } while (pageNumber <= totalPages);

    const productIds = new Set(products.map(p => String(p.id)));
    const overlap = reservationIds.filter(id => productIds.has(String(id)));
    const missing = reservationIds.filter(id => !productIds.has(String(id)));
    console.log(`Woo Store API products: ${products.length}/${Number.isFinite(totalProducts) ? totalProducts : "?"} across ${totalPages} page(s)`);
    console.log(`Confirmed-reservation ID coverage in Store API: ${overlap.length}/${reservationIds.length}`);
    if (missing.length) console.log(`Missing reservation IDs sample: ${missing.slice(0, 15).join(", ")}`);

    if (overlap.length) {
      const sample = products.find(p => String(p.id) === String(overlap[0]));
      console.log("Sample matching Store API product fields:");
      console.log(JSON.stringify({
        id: sample?.id,
        name: sample?.name,
        permalink: sample?.permalink,
        prices: sample?.prices,
        short_description: strip(sample?.short_description || "").slice(0, 400),
        description: strip(sample?.description || "").slice(0, 600),
      }, null, 2));
    }
  } catch (error) {
    console.log(`Woo Store API test failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function attachNetworkCapture(page, events) {
  page.on("response", async response => {
    try {
      const request = response.request();
      const type = request.resourceType();
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (!(type === "xhr" || type === "fetch" || /json/i.test(contentType) || /api|graphql|wp-json|admin-ajax|reservation|deal/i.test(url))) return;
      let snippet = "";
      if (/json|text|javascript/i.test(contentType) && Number(response.headers()["content-length"] || 0) < 500000) {
        try { snippet = (await response.text()).slice(0, 300).replace(/\s+/g, " "); } catch {}
      }
      events.push({ method: request.method(), type, status: response.status(), contentType, url, snippet });
    } catch {}
  });
}

function printEvents(events) {
  const seen = new Set();
  let printed = 0;
  for (const event of events) {
    const key = `${event.method} ${event.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${event.method} ${event.status} [${event.type}] ${event.contentType} ${event.url}`);
    if (event.snippet) console.log(`  ${event.snippet}`);
    printed += 1;
    if (printed >= 100) break;
  }
  if (!printed) console.log("  (none)");
}

function uniqueMatches(text, regex, group = 0) {
  const found = new Set();
  for (const match of String(text).matchAll(regex)) {
    if (match[group]) found.add(String(match[group]).toUpperCase());
  }
  return [...found];
}

function strip(value) {
  return String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

function textToPlain(value) {
  return strip(value).replace(/&dollar;|&#36;/gi, "$").replace(/&middot;|&#183;/gi, "·");
}

import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const sources = [
  { name: "David's", url: "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent/" },
  { name: "Rare Finds", url: "https://dvcreservations.com/rarefinds.php" },
  { name: "Rare Finds list", url: "https://dvcreservations.com/rarefindslist.php" },
];

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

try {
  for (const source of sources) await inspectSource(context, source);
} finally {
  await browser.close();
}

async function inspectSource(context, source) {
  console.log(`\n===== ${source.name.toUpperCase()} SOURCE PROBE =====`);

  try {
    const raw = await fetch(source.url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      },
    });
    const text = await raw.text();
    console.log(`Raw fetch: HTTP ${raw.status}, type=${raw.headers.get("content-type") || ""}, bytes=${text.length}`);
    console.log(`Raw hints: dollar=${count(text, /\$\s*\d/g)}, point=${count(text, /\bpoints?\b/gi)}, reservation=${count(text, /\breservations?\b/gi)}`);
    const rawUrls = endpointHints(text, source.url);
    console.log(`Raw-document endpoint hints (${rawUrls.length}):`);
    for (const hint of rawUrls.slice(0, 50)) console.log(`  RAW-HINT ${hint}`);
  } catch (error) {
    console.log(`Raw fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const page = await context.newPage();
  const events = [];
  page.on("response", async response => {
    try {
      const request = response.request();
      const type = request.resourceType();
      const url = response.url();
      const sameHost = new URL(url).hostname === new URL(source.url).hostname;
      if (!(type === "xhr" || type === "fetch" || (sameHost && /api|ajax|json|graphql|reservation|rare|confirmed/i.test(url)))) return;
      if (/google|facebook|doubleclick|tiktok|analytics|recaptcha/i.test(url)) return;
      const contentType = response.headers()["content-type"] || "";
      let preview = "";
      if (/json|text|javascript|html/i.test(contentType)) {
        try { preview = (await response.text()).slice(0, 500).replace(/\s+/g, " "); } catch {}
      }
      events.push({ method: request.method(), status: response.status(), type, contentType, url, preview });
    } catch {}
  });

  try {
    await page.goto(source.url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    console.log(`Browser title: ${await page.title()}`);
    console.log(`Browser body characters: ${body.length}`);
    console.log(`Browser hints: dollar=${count(body, /\$\s*\d/g)}, point=${count(body, /\bpoints?\b/gi)}, reservation=${count(body, /\breservations?\b/gi)}`);

    const scripts = await page.locator("script[src]").evaluateAll(nodes => [...new Set(nodes.map(n => n.src).filter(Boolean))]);
    console.log(`Script files: ${scripts.length}`);
    const bundleHints = [];
    for (const script of scripts.slice(0, 50)) {
      try {
        const response = await page.request.get(script, { timeout: 20000 });
        if (!response.ok()) continue;
        const contentType = response.headers()["content-type"] || "";
        if (!/javascript|text/i.test(contentType)) continue;
        const text = (await response.text()).slice(0, 2500000);
        const hints = endpointHints(text, source.url);
        if (hints.length) bundleHints.push({ script, hints });
      } catch {}
    }
    console.log(`Script endpoint hints (${bundleHints.reduce((n, item) => n + item.hints.length, 0)}):`);
    for (const item of bundleHints.slice(0, 20)) {
      console.log(`  SCRIPT ${item.script}`);
      for (const hint of item.hints.slice(0, 20)) console.log(`    ${hint}`);
    }

    console.log(`Relevant XHR/fetch responses (${events.length}):`);
    const seen = new Set();
    for (const event of events) {
      const key = `${event.method} ${event.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ${event.method} ${event.status} [${event.type}] ${event.contentType} ${event.url}`);
      if (event.preview) console.log(`    ${event.preview}`);
    }
    if (!seen.size) console.log("  (none — data appears to arrive in the document HTML)");
  } catch (error) {
    console.log(`Browser probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }
}

function endpointHints(text, baseUrl) {
  const values = new Set();
  const input = String(text || "");
  const regexes = [
    /https?:\\?\/\\?\/[^"'`<>\\s)]+/gi,
    /["'`]([^"'`]*(?:\/api\/|wp-json|admin-ajax|graphql|\.json(?:\?|$)|ajax[^"'`]*|confirmed[^"'`]*reservation|rare[^"'`]*find)[^"'`]*)["'`]/gi,
  ];
  for (const regex of regexes) {
    for (const match of input.matchAll(regex)) {
      let value = (match[1] || match[0]).replace(/\\\//g, "/").replace(/&amp;/g, "&");
      if (!/api|wp-json|ajax|graphql|json|reservation|rare/i.test(value)) continue;
      if (/google|facebook|doubleclick|tiktok|analytics|recaptcha|fonts|schema\.org/i.test(value)) continue;
      try {
        if (value.startsWith("/")) value = new URL(value, baseUrl).toString();
      } catch {}
      values.add(value.slice(0, 700));
      if (values.size >= 100) break;
    }
  }
  return [...values];
}

function count(text, regex) { return [...String(text || "").matchAll(regex)].length; }

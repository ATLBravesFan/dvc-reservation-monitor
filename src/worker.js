import baseWorker from "./index.js";
import { runRareFinds } from "./rare-finds.js";
import { Storage } from "./storage.js";

const GITHUB_REPO = "ATLBravesFan/dvc-reservation-monitor";
const DVC_RENTAL_WORKFLOW = "dvc-rental-browser.yml";

export default {
  async scheduled(event, env, ctx) {
    baseWorker.scheduled(event, env, ctx);

    const now = new Date(event.scheduledTime || Date.now());
    const minute = now.getUTCMinutes();

    if (minute % 10 === 0) {
      ctx.waitUntil(dispatchDvcRentalBrowser(env, now));
    }

    if (minute % 15 === 0) {
      ctx.waitUntil(runRareFinds(env, now));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run" && request.method === "POST" && url.searchParams.get("mode") === "rare-finds") {
      if (!env.ADMIN_TOKEN || (request.headers.get("authorization") || "") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await runRareFinds(env, new Date());
        return new Response(JSON.stringify({ rareFinds: result }, null, 2), {
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ rareFinds: { ok: false, error: error instanceof Error ? error.message : String(error) } }, null, 2), {
          status: 500,
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      }
    }

    return baseWorker.fetch(request, env);
  },
};

async function dispatchDvcRentalBrowser(env, now) {
  const store = new Storage(env.DB);
  try {
    if (!env.GITHUB_DISPATCH_TOKEN) throw new Error("GITHUB_DISPATCH_TOKEN not configured");

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${DVC_RENTAL_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "DVC-Reservation-Monitor",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (response.status !== 204) {
      throw new Error(`GitHub DVC-Rental workflow dispatch ${response.status}: ${(await response.text()).slice(0, 250)}`);
    }

    const details = { ok: true, dispatchedAt: now.toISOString() };
    await store.recordHealth("dvc-rental-dispatch", true, details, null);
    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await store.recordHealth("dvc-rental-dispatch", false, null, message); } catch { /* keep dispatch failure primary */ }
    return { ok: false, error: message };
  }
}

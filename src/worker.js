import baseWorker from "./index.js";
import { runRareFinds } from "./rare-finds.js";

export default {
  async scheduled(event, env, ctx) {
    baseWorker.scheduled(event, env, ctx);

    const now = new Date(event.scheduledTime || Date.now());
    if (now.getUTCMinutes() % 15 === 0) {
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

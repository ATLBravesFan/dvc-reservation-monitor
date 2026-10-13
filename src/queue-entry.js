import worker from "./worker.js";

const TICK_TYPE = "scheduled-tick";

export default {
  async scheduled(event, env) {
    if (!env.DVC_TICK_QUEUE) throw new Error("DVC_TICK_QUEUE binding is not configured");

    await env.DVC_TICK_QUEUE.send({
      type: TICK_TYPE,
      scheduledTime: event.scheduledTime || Date.now(),
      enqueuedAt: Date.now(),
    });
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const body = message.body || {};
      if (body.type !== TICK_TYPE) {
        throw new Error(`Unexpected queue message type: ${String(body.type || "missing")}`);
      }

      const scheduledTime = Number(body.scheduledTime);
      if (!Number.isFinite(scheduledTime)) {
        throw new Error("Queue tick is missing a valid scheduledTime");
      }

      // Reuse the existing scheduler unchanged, but run it inside a Queue
      // consumer invocation. Cloudflare waits for all ctx.waitUntil() promises
      // before acknowledging the Queue message, so the existing source jobs,
      // D1 writes, browser dispatches, health checks and alert delivery retain
      // their current behavior while receiving the Queue consumer CPU budget.
      await worker.scheduled({ scheduledTime }, env, ctx);
    }
  },

  async fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },
};

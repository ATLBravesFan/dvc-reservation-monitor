import worker from "./worker.js";

const TICK_TYPE = "scheduled-tick";
const EXECUTION_HISTORY_RETENTION_DAYS = 14;

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

      // Keep execution diagnostics bounded so historical rows cannot grow
      // forever. The migration adds an index on started_at, making this one
      // daily cleanup inexpensive. Run it in the Queue consumer rather than
      // the 10 ms cron producer so monitoring cadence is unaffected.
      const scheduledDate = new Date(scheduledTime);
      if (scheduledDate.getUTCHours() === 0 && scheduledDate.getUTCMinutes() === 7) {
        const cutoff = new Date(
          scheduledDate.getTime() - EXECUTION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString();
        ctx.waitUntil(
          env.DB.prepare("DELETE FROM execution_history WHERE started_at < ?")
            .bind(cutoff)
            .run()
            .catch(error => console.error(
              "execution history cleanup failed",
              error instanceof Error ? error.message : String(error),
            )),
        );
      }
    }
  },

  async fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },
};

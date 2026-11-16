import app from "./app";
import { MongoDBConnection } from "./db/store";
import type { Env, WebhookMessage } from "./env";
import { errorInfo, log } from "./lib/log";
import { reconcile } from "./services/reconcile";
import { handleWebhookBatch, sweepWebhooks } from "./services/webhooks";

export { MongoDBConnection };

export default {
  // HTTP API: tenants, admin, and Safaricom callbacks.
  fetch: app.fetch,

  // Tenant webhook delivery with retries and backoff.
  queue: (batch, env) => handleWebhookBatch(batch, env),

  // Every 5 minutes: resolve stuck transactions and re-queue lost webhooks.
  scheduled: async (_controller, env, ctx) => {
    const run = async (name: string, job: () => Promise<void>) => {
      try {
        await job();
      } catch (error) {
        log("error", "cron.failed", { job: name, ...errorInfo(error) });
      }
    };
    ctx.waitUntil(Promise.all([run("reconcile", () => reconcile(env)), run("webhooks", () => sweepWebhooks(env))]));
  },
} satisfies ExportedHandler<Env, WebhookMessage>;

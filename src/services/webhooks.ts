import { getStore } from "../db/client";
import type { Env, WebhookMessage } from "../env";
import { signWebhook, unseal } from "../lib/crypto";
import { errorInfo, log } from "../lib/log";
import { webhookSecretContext } from "./accounts";

const MAX_ATTEMPTS = 10;

/** 30s, 60s, 2m, 4m ... capped at 1h. */
function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600);
}

type Outcome = { delivered: boolean; statusCode?: number; error?: string };

async function deliver(env: Env, deliveryId: string): Promise<Outcome | "skip"> {
  const found = await getStore(env).getWebhookDelivery(deliveryId);
  if (!found || found.delivery.status !== "pending") return "skip";
  const { delivery, body, secret } = found;

  const signingSecret = await unseal(env, secret, webhookSecretContext(delivery.businessId, delivery.environment));
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook(signingSecret, timestamp, body);

  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RotsiPayments-Webhooks/1",
        "rotsi-event-id": delivery.eventId,
        "rotsi-event-type": delivery.eventType,
        "rotsi-signature": `t=${timestamp},v1=${signature}`,
      },
      body,
      redirect: "manual", // never follow a redirect to somewhere unverified
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { delivered: response.status >= 200 && response.status < 300, statusCode: response.status };
  } catch (error) {
    return { delivered: false, error: errorInfo(error).message.slice(0, 200) };
  }
}

/** Queue consumer. At-least-once: tenants dedupe on rotsi-event-id. */
export async function handleWebhookBatch(batch: MessageBatch<WebhookMessage>, env: Env): Promise<void> {
  const store = getStore(env);
  for (const message of batch.messages) {
    const { deliveryId } = message.body;
    try {
      const outcome = await deliver(env, deliveryId);
      if (outcome === "skip") {
        message.ack();
        continue;
      }
      if (outcome.delivered) {
        await store.recordWebhookAttempt(deliveryId, { status: "delivered", statusCode: outcome.statusCode });
        message.ack();
        continue;
      }
      const giveUp = message.attempts >= MAX_ATTEMPTS;
      const delay = backoffSeconds(message.attempts);
      await store.recordWebhookAttempt(deliveryId, {
        status: giveUp ? "failed" : "pending",
        statusCode: outcome.statusCode,
        error: outcome.error,
        retryInSeconds: delay,
      });
      if (giveUp) message.ack();
      else message.retry({ delaySeconds: delay });
    } catch (error) {
      log("error", "webhook.delivery_error", { deliveryId, ...errorInfo(error) });
      message.retry({ delaySeconds: backoffSeconds(message.attempts) });
    }
  }
}

/** Cron: re-queue deliveries whose queue message was lost. */
export async function sweepWebhooks(env: Env): Promise<void> {
  const ids = await getStore(env).claimStuckDeliveries(new Date(Date.now() - 15 * 60_000).toISOString(), 100);
  if (ids.length === 0) return;
  await env.WEBHOOK_QUEUE.sendBatch(ids.map((deliveryId) => ({ body: { deliveryId } })));
  log("info", "webhook.swept", { count: ids.length });
}

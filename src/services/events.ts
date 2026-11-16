import { getStore } from "../db/client";
import type { Transaction } from "../db/models";
import type { TransitionResult } from "../db/store";
import type { Env } from "../env";
import { newId, toPublicId } from "../lib/ids";
import { errorInfo, log } from "../lib/log";

/** The only shape of a transaction tenants ever see. */
export function transactionView(t: Transaction) {
  return {
    id: toPublicId("transaction", t._id),
    type: t.type,
    direction: t.direction,
    status: t.status,
    amount: t.amount,
    currency: t.currency,
    environment: t.environment,
    phone: t.msisdn,
    counterparty: t.counterparty,
    accountReference: t.accountReference,
    description: t.description,
    receipt: t.receipt,
    resultCode: t.resultCode,
    resultDescription: t.resultDescription,
    needsReview: t.needsReview || undefined,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * Persist a webhook delivery record, then hand it to the queue. If the queue
 * send fails the record stays pending and the cron sweeper re-sends it.
 */
export async function emitTransactionEvent(env: Env, transaction: Transaction, eventType: string): Promise<void> {
  const eventId = toPublicId("event", newId());
  const payload = {
    id: eventId,
    type: eventType,
    createdAt: new Date().toISOString(),
    environment: transaction.environment,
    data: transactionView(transaction),
  };
  const deliveryId = await getStore(env).createWebhookDelivery({
    businessId: transaction.businessId,
    environment: transaction.environment,
    eventId,
    eventType,
    transactionId: transaction._id,
    payload,
  });
  if (!deliveryId) return;
  try {
    await env.WEBHOOK_QUEUE.send({ deliveryId });
  } catch (error) {
    log("warn", "webhook.enqueue_failed", { deliveryId, ...errorInfo(error) });
  }
}

/**
 * Side effects of a status change, run once because transition() is atomic:
 * notify the tenant, and give back daily payout headroom for failed payouts.
 */
export async function afterTransition(env: Env, result: TransitionResult): Promise<void> {
  const transaction = result.transaction;
  if (!transaction) return;

  if (result.conflict) {
    await getStore(env).audit({
      businessId: transaction.businessId,
      actorType: "system",
      action: "transaction.conflicting_outcome",
      resourceType: "transaction",
      resourceId: transaction._id,
    });
    return;
  }
  if (!result.applied) return;

  if (transaction.status === "FAILED" && transaction.direction === "OUT" && transaction.reservedDay) {
    await getStore(env).releasePayout(transaction.accountId, transaction.reservedDay, transaction.amount);
  }
  if (transaction.status !== "PROCESSING" && transaction.status !== "REQUEST_RECEIVED") {
    await emitTransactionEvent(env, transaction, `transaction.${transaction.status.toLowerCase()}`);
  }
}

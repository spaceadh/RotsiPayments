import { getStore } from "../db/client";
import type { Transaction } from "../db/models";
import type { Env } from "../env";
import { errorInfo, log } from "../lib/log";
import { loadAccountById } from "./accounts";
import { afterTransition } from "./events";
import { hookUrl } from "./hooks";

const STALE_AFTER_MS = 3 * 60_000; // give callbacks a fair chance first
const RETRY_EVERY_MS = 10 * 60_000;
const MAX_ATTEMPTS = 12; // ~2 hours of asking, then a human looks
const BATCH = 25;

/**
 * Resolve PROCESSING/UNKNOWN transactions by asking Safaricom, never by
 * re-sending money. STK is answered synchronously by STK Query; B2C/B2B use
 * the asynchronous Transaction Status API whose answer lands on /hooks/status.
 */
export async function reconcile(env: Env): Promise<void> {
  const store = getStore(env);
  const now = Date.now();
  const candidates = await store.listForReconciliation({
    olderThan: new Date(now - STALE_AFTER_MS).toISOString(),
    retryAfter: new Date(now - RETRY_EVERY_MS).toISOString(),
    limit: BATCH,
  });

  for (const transaction of candidates) {
    try {
      await reconcileOne(env, transaction);
    } catch (error) {
      log("error", "reconcile.failed", { transactionId: transaction._id, ...errorInfo(error) });
    }
  }
}

async function reconcileOne(env: Env, transaction: Transaction): Promise<void> {
  const store = getStore(env);
  if (transaction.reconcileAttempts >= MAX_ATTEMPTS) {
    await store.flagForReview(transaction._id, "Unresolved after automatic reconciliation.");
    return;
  }
  await store.markReconcileAttempt(transaction._id);

  const loaded = await loadAccountById(env, transaction.accountId);
  if (!loaded) {
    await store.flagForReview(transaction._id, "M-Pesa account no longer exists.");
    return;
  }
  const { account, credentials, client } = loaded;

  if (transaction.type === "STK_PUSH") {
    if (!transaction.checkoutRequestId || !credentials.passkey) {
      await store.flagForReview(transaction._id, "No CheckoutRequestID to query; the push may never have reached M-Pesa.");
      return;
    }
    const result = await client.stkQuery({
      shortcode: account.shortcode,
      passkey: credentials.passkey,
      checkoutRequestId: transaction.checkoutRequestId,
    });
    if (result.kind !== "ok" || result.data.ResultCode === undefined) return; // still processing or unreachable
    const code = String(result.data.ResultCode);
    const outcome = await store.transition(
      transaction._id,
      code === "0" ? "SUCCESS" : "FAILED",
      { resultCode: code, resultDescription: result.data.ResultDesc },
      "reconciliation",
    );
    await afterTransition(env, outcome);
    return;
  }

  if (transaction.type === "B2C" || transaction.type === "B2B") {
    const reference = transaction.originatorConversationId ?? transaction.conversationId;
    if (!reference && !transaction.receipt) {
      await store.flagForReview(transaction._id, "No conversation reference to query.");
      return;
    }
    if (!credentials.initiatorName || !credentials.securityCredential) return;
    await client.transactionStatus({
      initiatorName: credentials.initiatorName,
      securityCredential: credentials.securityCredential,
      shortcode: account.shortcode,
      transactionId: transaction.receipt,
      originalConversationId: reference,
      resultUrl: await hookUrl(env, "status", transaction._id),
      timeoutUrl: await hookUrl(env, "status-timeout", transaction._id),
    });
  }
}

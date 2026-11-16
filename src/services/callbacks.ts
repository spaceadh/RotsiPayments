import { z } from "zod";
import { getStore } from "../db/client";
import type { Transaction } from "../db/models";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";
import { log } from "../lib/log";
import { afterTransition, emitTransactionEvent } from "./events";

/**
 * Safaricom callback handling. Order matters:
 *   1. persist the raw event (so nothing Safaricom tells us is ever lost)
 *   2. apply the state transition (atomic + idempotent, so retries are safe)
 *   3. queue the tenant webhook
 *   4. only then acknowledge Safaricom
 * If any step throws, the route returns 500 and nothing is acknowledged.
 */

const scalar = z.union([z.string(), z.number()]).transform(String);

const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().optional(),
      CheckoutRequestID: z.string(),
      ResultCode: scalar,
      ResultDesc: z.string().optional(),
      CallbackMetadata: z
        .object({ Item: z.array(z.object({ Name: z.string(), Value: scalar.optional() })) })
        .optional(),
    }),
  }),
});

const resultSchema = z.object({
  Result: z.object({
    ResultType: scalar.optional(),
    ResultCode: scalar,
    ResultDesc: z.string().optional(),
    OriginatorConversationID: z.string().optional(),
    ConversationID: z.string().optional(),
    TransactionID: z.string().optional(),
    ResultParameters: z
      .object({
        ResultParameter: z
          .union([
            z.array(z.object({ Key: z.string(), Value: scalar.optional() })),
            z.object({ Key: z.string(), Value: scalar.optional() }),
          ])
          .optional(),
      })
      .optional(),
  }),
});

const c2bSchema = z.object({
  TransactionType: z.string().optional(),
  TransID: z.string().min(1),
  TransTime: z.string().optional(),
  TransAmount: scalar,
  BusinessShortCode: scalar,
  BillRefNumber: z.string().optional(),
  MSISDN: scalar.optional(),
  FirstName: z.string().optional(),
});

function resultParameters(result: z.infer<typeof resultSchema>["Result"]): Record<string, string | undefined> {
  const raw = result.ResultParameters?.ResultParameter;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return Object.fromEntries(list.map((p) => [p.Key, p.Value]));
}

async function persist(
  env: Env,
  kind: string,
  dedup: string,
  payload: unknown,
  scope: { transaction?: Transaction; accountId?: string; businessId?: string },
): Promise<void> {
  const payloadHash = await sha256Hex(JSON.stringify(payload));
  await getStore(env).recordEvent({
    dedupKey: `${kind}:${dedup}:${payloadHash.slice(0, 16)}`,
    kind,
    environment: scope.transaction?.environment,
    businessId: scope.transaction?.businessId ?? scope.businessId,
    accountId: scope.transaction?.accountId ?? scope.accountId,
    transactionId: scope.transaction?._id,
    payload,
    payloadHash,
  });
}

// ----------------------------------------------------------------- STK Push

export async function handleStkCallback(env: Env, transactionId: string, payload: unknown): Promise<void> {
  const store = getStore(env);
  const transaction = await store.getTransaction(transactionId);
  await persist(env, "stk", transactionId, payload, { transaction: transaction ?? undefined });

  const parsed = stkCallbackSchema.safeParse(payload);
  if (!transaction || transaction.type !== "STK_PUSH" || !parsed.success) {
    log("warn", "callback.stk_unusable", { transactionId, found: Boolean(transaction), parsed: parsed.success });
    return;
  }

  const cb = parsed.data.Body.stkCallback;
  if (transaction.checkoutRequestId && transaction.checkoutRequestId !== cb.CheckoutRequestID) {
    await store.flagForReview(transactionId, "STK callback CheckoutRequestID did not match.");
    return;
  }

  const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((item) => [item.Name, item.Value]));
  const success = cb.ResultCode === "0";
  const outcome = await store.transition(
    transactionId,
    success ? "SUCCESS" : "FAILED",
    {
      checkoutRequestId: cb.CheckoutRequestID,
      merchantRequestId: cb.MerchantRequestID,
      receipt: success ? items.MpesaReceiptNumber : undefined,
      resultCode: cb.ResultCode,
      resultDescription: cb.ResultDesc,
    },
    "callback",
  );
  if (success && items.Amount !== undefined && Number(items.Amount) !== transaction.amount) {
    await store.flagForReview(transactionId, `Paid amount ${items.Amount} differs from requested ${transaction.amount}.`);
  }
  await afterTransition(env, outcome);
}

// ------------------------------------------------- B2C / B2B result + timeout

export async function handleResultCallback(env: Env, transactionId: string, payload: unknown): Promise<void> {
  const store = getStore(env);
  const transaction = await store.getTransaction(transactionId);
  await persist(env, "result", transactionId, payload, { transaction: transaction ?? undefined });

  const parsed = resultSchema.safeParse(payload);
  if (!transaction || transaction.direction !== "OUT" || !parsed.success) {
    log("warn", "callback.result_unusable", { transactionId, found: Boolean(transaction), parsed: parsed.success });
    return;
  }
  const result = parsed.data.Result;
  if (transaction.conversationId && result.ConversationID && transaction.conversationId !== result.ConversationID) {
    await store.flagForReview(transactionId, "Result ConversationID did not match.");
    return;
  }
  const success = result.ResultCode === "0";
  const outcome = await store.transition(
    transactionId,
    success ? "SUCCESS" : "FAILED",
    {
      conversationId: result.ConversationID,
      originatorConversationId: result.OriginatorConversationID,
      receipt: success ? result.TransactionID : undefined,
      resultCode: result.ResultCode,
      resultDescription: result.ResultDesc,
    },
    "callback",
  );
  await afterTransition(env, outcome);
}

/** A queue timeout does not prove the payout failed. Mark UNKNOWN and reconcile. */
export async function handleTimeoutCallback(env: Env, transactionId: string, payload: unknown): Promise<void> {
  const store = getStore(env);
  const transaction = await store.getTransaction(transactionId);
  await persist(env, "timeout", transactionId, payload, { transaction: transaction ?? undefined });
  if (!transaction) return;
  const outcome = await store.transition(
    transactionId,
    "UNKNOWN",
    { resultDescription: "M-Pesa queue timeout; awaiting reconciliation." },
    "timeout",
  );
  await afterTransition(env, outcome);
}

// ----------------------------------------------- Transaction Status results

export async function handleStatusCallback(env: Env, transactionId: string, payload: unknown): Promise<void> {
  const store = getStore(env);
  const transaction = await store.getTransaction(transactionId);
  await persist(env, "status", transactionId, payload, { transaction: transaction ?? undefined });

  const parsed = resultSchema.safeParse(payload);
  if (!transaction || !parsed.success) return;
  const result = parsed.data.Result;
  if (result.ResultCode !== "0") {
    log("info", "reconcile.status_query_unresolved", { transactionId, resultCode: result.ResultCode });
    return;
  }
  const params = resultParameters(result);
  const status = params.TransactionStatus;
  if (status === "Completed") {
    const outcome = await store.transition(
      transactionId,
      "SUCCESS",
      { receipt: params.ReceiptNo ?? result.TransactionID, resultCode: "0", resultDescription: "Confirmed by status query." },
      "reconciliation",
    );
    await afterTransition(env, outcome);
  } else {
    // Only a clear "Completed" is acted on automatically. Anything else goes to a human.
    await store.flagForReview(transactionId, `Status query returned "${status ?? "no status"}".`);
  }
}

// ---------------------------------------------------------------------- C2B

export type ValidationReply = { ResultCode: string; ResultDesc: string };

export async function handleC2BValidation(env: Env, accountId: string, payload: unknown): Promise<ValidationReply> {
  const account = await getStore(env).getDarajaAccount(accountId);
  const parsed = c2bSchema.safeParse(payload);
  if (!account || account.status !== "active") return { ResultCode: "C2B00016", ResultDesc: "Rejected" };
  if (!parsed.success) return { ResultCode: "C2B00016", ResultDesc: "Rejected" };
  if (Number(parsed.data.TransAmount) > account.limits.maxTransactionAmount) {
    return { ResultCode: "C2B00013", ResultDesc: "Rejected" };
  }
  return { ResultCode: "0", ResultDesc: "Accepted" };
}

export async function handleC2BConfirmation(env: Env, accountId: string, payload: unknown): Promise<void> {
  const store = getStore(env);
  const account = await store.getDarajaAccount(accountId);
  const parsed = c2bSchema.safeParse(payload);
  const dedup = parsed.success ? parsed.data.TransID : accountId;
  await persist(env, "c2b", dedup, payload, { accountId: account?._id, businessId: account?.businessId });

  if (!account || !parsed.success) {
    log("warn", "callback.c2b_unusable", { accountId, found: Boolean(account), parsed: parsed.success });
    return;
  }
  const c2b = parsed.data;
  if (account.environment === "production" && c2b.BusinessShortCode !== account.shortcode) {
    log("warn", "callback.c2b_shortcode_mismatch", { accountId });
    return;
  }
  // STK payments to a paybill can also arrive here. Don't double-count them.
  if (await store.findByReceipt(account.environment, c2b.TransID)) return;

  const { created, transaction } = await store.createTransaction({
    id: newId(),
    businessId: account.businessId,
    accountId: account._id,
    environment: account.environment,
    type: "C2B",
    direction: "IN",
    status: "SUCCESS",
    amount: Number(c2b.TransAmount),
    msisdn: c2b.MSISDN,
    accountReference: c2b.BillRefNumber,
    payerName: c2b.FirstName,
    receipt: c2b.TransID,
    source: "callback",
  });
  if (created) await emitTransactionEvent(env, transaction, "transaction.success");
}

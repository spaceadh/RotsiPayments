import type { DarajaResult } from "../daraja/client";
import { getStore } from "../db/client";
import type { Scope, Transaction, TransactionType } from "../db/models";
import type { NewTransaction, TransactionFields } from "../db/store";
import type { Env, Environment } from "../env";
import { sha256Hex } from "../lib/crypto";
import { AppError } from "../lib/http";
import { newId } from "../lib/ids";
import { loadAccount, type LoadedAccount } from "./accounts";
import { afterTransition } from "./events";
import { hookUrl } from "./hooks";

export type Tenant = {
  apiKeyId: string;
  businessId: string;
  environment: Environment;
  scopes: Scope[];
};

/** Today's date in Kenya (EAT), used for daily payout limits. */
function eatDay(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

async function requireAccount(env: Env, tenant: Tenant, payout = false): Promise<LoadedAccount> {
  if (tenant.environment === "production" && env.LIVE_PAYMENTS_ENABLED !== "true") {
    throw new AppError(403, "LIVE_PAYMENTS_DISABLED", "Live payments are not enabled yet.");
  }
  const loaded = await loadAccount(env, tenant.businessId, tenant.environment);
  if (!loaded) {
    throw new AppError(409, "MPESA_NOT_CONFIGURED", "No M-Pesa account is configured for this environment.");
  }
  if (loaded.account.status !== "active") {
    throw new AppError(403, "MPESA_ACCOUNT_DISABLED", "The M-Pesa account for this business is disabled.");
  }
  if (payout) {
    if (!loaded.account.payoutsEnabled) {
      throw new AppError(403, "PAYOUTS_NOT_APPROVED", "Payouts have not been approved for this business.");
    }
    if (!loaded.credentials.initiatorName || !loaded.credentials.securityCredential) {
      throw new AppError(409, "INITIATOR_NOT_CONFIGURED", "Payout initiator credentials are not configured.");
    }
  }
  return loaded;
}

function enforceAmount(loaded: LoadedAccount, amount: number): void {
  if (amount > loaded.account.limits.maxTransactionAmount) {
    throw new AppError(422, "AMOUNT_ABOVE_LIMIT", "The amount exceeds this account's per-transaction limit.");
  }
}

type Draft = Omit<NewTransaction, "id" | "businessId" | "accountId" | "environment" | "status" | "source" | "idempotencyKey" | "requestHash"> & {
  type: TransactionType;
};

/**
 * Create the REQUEST_RECEIVED record before calling Safaricom. A repeated
 * Idempotency-Key returns the original transaction; reusing a key with a
 * different body is refused.
 */
async function openTransaction(
  env: Env,
  tenant: Tenant,
  loaded: LoadedAccount,
  draft: Draft,
  idempotencyKey: string,
  request: unknown,
): Promise<{ transaction: Transaction; replay: boolean }> {
  const requestHash = await sha256Hex(JSON.stringify(request));
  const { created, transaction } = await getStore(env).createTransaction({
    ...draft,
    id: newId(),
    businessId: tenant.businessId,
    accountId: loaded.account._id,
    environment: tenant.environment,
    status: "REQUEST_RECEIVED",
    idempotencyKey,
    requestHash,
    source: "api",
  });
  if (!created && transaction.requestHash !== requestHash) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request.");
  }
  return { transaction, replay: !created };
}

/**
 * Apply Safaricom's synchronous answer. Acceptance means PROCESSING, not paid;
 * the final outcome comes by callback or reconciliation.
 */
async function settleInitiation<T>(
  env: Env,
  transaction: Transaction,
  result: DarajaResult<T>,
  accepted: (data: T) => { refs: TransactionFields } | { code: string; description: string },
): Promise<Transaction> {
  const store = getStore(env);
  let outcome;
  if (result.kind === "ok") {
    const decision = accepted(result.data);
    if ("refs" in decision) {
      await store.setTransactionRefs(transaction._id, decision.refs);
      outcome = await store.transition(transaction._id, "PROCESSING", {}, "initiation");
    } else {
      outcome = await store.transition(
        transaction._id,
        "FAILED",
        { resultCode: decision.code, resultDescription: decision.description },
        "initiation",
      );
    }
  } else if (result.kind === "rejected") {
    outcome = await store.transition(
      transaction._id,
      "FAILED",
      { resultCode: result.code, resultDescription: result.message },
      "initiation",
    );
  } else {
    // Do not retry: the request may have reached M-Pesa. Reconciliation decides.
    outcome = await store.transition(transaction._id, "UNKNOWN", { resultDescription: result.reason }, "initiation");
  }
  await afterTransition(env, outcome);
  return outcome.transaction ?? (await store.getTransaction(transaction._id)) ?? transaction;
}

// ------------------------------------------------------------------ STK Push

export async function stkPush(
  env: Env,
  tenant: Tenant,
  input: { phone: string; amount: number; accountReference: string; description: string },
  idempotencyKey: string,
): Promise<{ transaction: Transaction; replay: boolean }> {
  const loaded = await requireAccount(env, tenant);
  const { account, credentials, client } = loaded;
  if (!credentials.passkey) {
    throw new AppError(409, "STK_NOT_CONFIGURED", "STK Push is not configured for this account.");
  }
  enforceAmount(loaded, input.amount);

  const opened = await openTransaction(
    env,
    tenant,
    loaded,
    {
      type: "STK_PUSH",
      direction: "IN",
      amount: input.amount,
      msisdn: input.phone,
      accountReference: input.accountReference,
      description: input.description,
    },
    idempotencyKey,
    input,
  );
  if (opened.replay) return opened;

  const isTill = account.shortcodeType === "till";
  const result = await client.stkPush({
    shortcode: account.shortcode,
    passkey: credentials.passkey,
    transactionType: isTill ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    partyB: isTill ? (account.tillNumber ?? account.shortcode) : account.shortcode,
    amount: input.amount,
    msisdn: input.phone,
    callbackUrl: await hookUrl(env, "stk", opened.transaction._id),
    accountReference: input.accountReference,
    description: input.description,
  });

  const transaction = await settleInitiation(env, opened.transaction, result, (data) =>
    data.ResponseCode === "0" && data.CheckoutRequestID
      ? { refs: { checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID } }
      : { code: String(data.ResponseCode ?? "UNEXPECTED"), description: String(data.ResponseDescription ?? "Rejected") },
  );
  return { transaction, replay: false };
}

// ------------------------------------------------------------- B2C and B2B

async function openPayout(
  env: Env,
  tenant: Tenant,
  loaded: LoadedAccount,
  draft: Draft,
  idempotencyKey: string,
  request: unknown,
) {
  enforceAmount(loaded, draft.amount);
  const opened = await openTransaction(env, tenant, loaded, draft, idempotencyKey, request);
  if (opened.replay) return opened;

  const store = getStore(env);
  const day = eatDay();
  const reserved = await store.reservePayout(
    loaded.account._id,
    day,
    draft.amount,
    loaded.account.limits.dailyPayoutLimit,
  );
  if (!reserved) {
    await store.transition(
      opened.transaction._id,
      "FAILED",
      { resultCode: "DAILY_LIMIT_EXCEEDED", resultDescription: "Daily payout limit reached." },
      "limits",
    );
    throw new AppError(422, "DAILY_LIMIT_EXCEEDED", "This payout would exceed the daily payout limit.");
  }
  await store.setTransactionRefs(opened.transaction._id, { reservedDay: day });
  return { transaction: { ...opened.transaction, reservedDay: day }, replay: false };
}

const ackAccepted = (data: { ResponseCode?: string; ResponseDescription?: string; ConversationID?: string; OriginatorConversationID?: string }) =>
  data.ResponseCode === "0"
    ? { refs: { conversationId: data.ConversationID, originatorConversationId: data.OriginatorConversationID } }
    : { code: String(data.ResponseCode ?? "UNEXPECTED"), description: String(data.ResponseDescription ?? "Rejected") };

export async function b2cPayment(
  env: Env,
  tenant: Tenant,
  input: {
    phone: string;
    amount: number;
    commandId: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
    remarks: string;
    occasion?: string;
  },
  idempotencyKey: string,
) {
  const loaded = await requireAccount(env, tenant, true);
  const opened = await openPayout(
    env,
    tenant,
    loaded,
    {
      type: "B2C",
      direction: "OUT",
      amount: input.amount,
      msisdn: input.phone,
      commandId: input.commandId,
      description: input.remarks,
    },
    idempotencyKey,
    input,
  );
  if (opened.replay) return opened;

  const id = opened.transaction._id;
  const result = await loaded.client.b2c({
    originatorConversationId: id,
    initiatorName: loaded.credentials.initiatorName!,
    securityCredential: loaded.credentials.securityCredential!,
    commandId: input.commandId,
    amount: input.amount,
    shortcode: loaded.account.shortcode,
    msisdn: input.phone,
    remarks: input.remarks,
    occasion: input.occasion,
    resultUrl: await hookUrl(env, "result", id),
    timeoutUrl: await hookUrl(env, "timeout", id),
  });
  return { transaction: await settleInitiation(env, opened.transaction, result, ackAccepted), replay: false };
}

export async function b2bPayment(
  env: Env,
  tenant: Tenant,
  input: {
    receiverShortcode: string;
    receiverType: "paybill" | "till";
    accountReference: string;
    amount: number;
    remarks: string;
  },
  idempotencyKey: string,
) {
  const loaded = await requireAccount(env, tenant, true);
  const opened = await openPayout(
    env,
    tenant,
    loaded,
    {
      type: "B2B",
      direction: "OUT",
      amount: input.amount,
      counterparty: input.receiverShortcode,
      accountReference: input.accountReference,
      commandId: input.receiverType === "till" ? "BusinessBuyGoods" : "BusinessPayBill",
      description: input.remarks,
    },
    idempotencyKey,
    input,
  );
  if (opened.replay) return opened;

  const id = opened.transaction._id;
  const result = await loaded.client.b2b({
    initiatorName: loaded.credentials.initiatorName!,
    securityCredential: loaded.credentials.securityCredential!,
    commandId: input.receiverType === "till" ? "BusinessBuyGoods" : "BusinessPayBill",
    amount: input.amount,
    shortcode: loaded.account.shortcode,
    receiverShortcode: input.receiverShortcode,
    accountReference: input.accountReference,
    remarks: input.remarks,
    resultUrl: await hookUrl(env, "result", id),
    timeoutUrl: await hookUrl(env, "timeout", id),
  });
  return { transaction: await settleInitiation(env, opened.transaction, result, ackAccepted), replay: false };
}

// ---------------------------------------------------------------------- C2B

export async function registerC2B(
  env: Env,
  businessId: string,
  environment: Environment,
  responseType: "Completed" | "Cancelled",
) {
  const loaded = await loadAccount(env, businessId, environment);
  if (!loaded) throw new AppError(404, "MPESA_NOT_CONFIGURED", "No M-Pesa account for this environment.");
  const accountId = loaded.account._id;
  const result = await loaded.client.registerC2BUrls({
    shortcode: loaded.account.shortcode,
    responseType,
    confirmationUrl: await hookUrl(env, "c2b-confirmation", accountId),
    validationUrl: await hookUrl(env, "c2b-validation", accountId),
  });
  if (result.kind !== "ok" || (result.data.ResponseCode && result.data.ResponseCode !== "0")) {
    const message =
      result.kind === "rejected"
        ? result.message
        : result.kind === "uncertain"
          ? result.reason
          : String(result.data.ResponseDescription ?? "Registration failed.");
    throw new AppError(502, "C2B_REGISTRATION_FAILED", message);
  }
  await getStore(env).updateDarajaAccount(businessId, environment, { c2bRegisteredAt: new Date() });
  return { registered: true, response: result.data.ResponseDescription };
}

export async function simulateC2B(
  env: Env,
  tenant: Tenant,
  input: { phone: string; amount: number; billRef: string },
) {
  if (tenant.environment !== "sandbox") {
    throw new AppError(403, "SANDBOX_ONLY", "Simulation is only available with test keys.");
  }
  const { account, client } = await requireAccount(env, tenant);
  const result = await client.simulateC2B({
    shortcode: account.shortcode,
    commandId: account.shortcodeType === "till" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    amount: input.amount,
    msisdn: input.phone,
    billRef: input.billRef,
  });
  if (result.kind !== "ok") {
    throw new AppError(502, "SIMULATION_FAILED", result.kind === "rejected" ? result.message : result.reason);
  }
  return { accepted: result.data.ResponseCode === "0", description: result.data.ResponseDescription };
}

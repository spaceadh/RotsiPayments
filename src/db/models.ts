import type { ObjectId } from "mongodb";
import type { Environment } from "../env";
import type { Sealed } from "../lib/crypto";

export const COLLECTIONS = {
  businesses: "payments_businesses",
  apiKeys: "payments_api_keys",
  darajaAccounts: "payments_daraja_accounts",
  transactions: "payments_transactions",
  paymentEvents: "payments_payment_events",
  webhookDeliveries: "payments_webhook_deliveries",
  payoutCounters: "payments_payout_counters",
  auditLogs: "payments_audit_logs",
} as const;

export const SCOPES = ["payments:read", "payments:write", "payouts:write"] as const;
export type Scope = (typeof SCOPES)[number];

export type TransactionType = "C2B" | "STK_PUSH" | "B2C" | "B2B";
export type TransactionStatus = "REQUEST_RECEIVED" | "PROCESSING" | "SUCCESS" | "FAILED" | "UNKNOWN";

export type BusinessDoc = {
  _id: ObjectId;
  name: string;
  slug: string;
  status: "active" | "suspended";
  /** Tenant webhook per environment. The signing secret is encrypted. */
  webhooks: Partial<Record<Environment, { url: string; secret: Sealed }>>;
  createdAt: Date;
  updatedAt: Date;
};

export type ApiKeyDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  environment: Environment;
  name: string;
  /** First characters of the key, for display only. */
  prefix: string;
  /** HMAC-SHA256 of the full key. The key itself is never stored. */
  keyHash: string;
  scopes: Scope[];
  status: "active" | "revoked";
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
};

export type DarajaCredentials = {
  consumerKey: string;
  consumerSecret: string;
  /** Lipa na M-Pesa Online passkey, for STK Push. */
  passkey?: string;
  /** B2C/B2B/status queries. */
  initiatorName?: string;
  /** Initiator password already encrypted with Safaricom's certificate (from the Daraja portal). */
  securityCredential?: string;
};

export type DarajaAccountDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  environment: Environment;
  /** Paybill number, or the store/head-office number for a till. */
  shortcode: string;
  shortcodeType: "paybill" | "till";
  /** Buy Goods till number (STK PartyB) when it differs from the shortcode. */
  tillNumber?: string;
  /** Encrypted JSON of DarajaCredentials. */
  credentials: Sealed;
  status: "active" | "disabled";
  /** Admin approval gate for B2C/B2B. */
  payoutsEnabled: boolean;
  limits: { maxTransactionAmount: number; dailyPayoutLimit: number };
  c2bRegisteredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TransactionDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  accountId: ObjectId;
  environment: Environment;
  type: TransactionType;
  direction: "IN" | "OUT";
  status: TransactionStatus;
  amount: number;
  currency: "KES";
  idempotencyKey?: string;
  requestHash?: string;

  msisdn?: string;
  counterparty?: string;
  accountReference?: string;
  description?: string;
  commandId?: string;
  payerName?: string;

  merchantRequestId?: string;
  checkoutRequestId?: string;
  conversationId?: string;
  originatorConversationId?: string;
  /** M-Pesa receipt / TransID. */
  receipt?: string;
  resultCode?: string;
  resultDescription?: string;

  /** EAT date the payout was counted against the daily limit. */
  reservedDay?: string;
  needsReview?: boolean;
  reviewReason?: string;
  reconcileAttempts: number;
  lastReconcileAt?: Date;
  statusHistory: { status: TransactionStatus; at: Date; source: string }[];
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentEventDoc = {
  _id: ObjectId;
  dedupKey: string;
  kind: string;
  environment?: Environment;
  businessId?: ObjectId;
  accountId?: ObjectId;
  transactionId?: ObjectId;
  /** Raw provider payload, retained as the record of what Safaricom told us. */
  payload: unknown;
  payloadHash: string;
  receivedAt: Date;
};

export type WebhookDeliveryDoc = {
  _id: ObjectId;
  businessId: ObjectId;
  environment: Environment;
  eventId: string;
  eventType: string;
  transactionId?: ObjectId;
  url: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode?: number;
  lastError?: string;
  nextAttemptAt: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PayoutCounterDoc = { _id: string; total: number; updatedAt: Date };

export type AuditLogDoc = {
  _id: ObjectId;
  businessId?: ObjectId;
  actorType: "system" | "business" | "admin";
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: Date;
};

/** What crosses the Durable Object RPC boundary: ObjectIds and Dates become strings. */
export type Plain<T> = T extends ObjectId
  ? string
  : T extends Date
    ? string
    : T extends Array<infer U>
      ? Plain<U>[]
      : T extends object
        ? { [K in keyof T]: Plain<T[K]> }
        : T;

export type Business = Plain<BusinessDoc>;
export type ApiKey = Plain<ApiKeyDoc>;
export type DarajaAccount = Plain<DarajaAccountDoc>;
export type Transaction = Plain<TransactionDoc>;
export type WebhookDelivery = Plain<WebhookDeliveryDoc>;

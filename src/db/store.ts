import { DurableObject } from "cloudflare:workers";
import {
  MongoClient,
  MongoServerError,
  ObjectId,
  type Collection,
  type Db,
  type Document,
  type Filter,
} from "mongodb";
import type { Env, Environment } from "../env";
import type { Sealed } from "../lib/crypto";
import {
  COLLECTIONS,
  type ApiKey,
  type ApiKeyDoc,
  type AuditLogDoc,
  type Business,
  type BusinessDoc,
  type DarajaAccount,
  type DarajaAccountDoc,
  type PaymentEventDoc,
  type PayoutCounterDoc,
  type Plain,
  type Scope,
  type Transaction,
  type TransactionDoc,
  type TransactionStatus,
  type TransactionType,
  type WebhookDelivery,
  type WebhookDeliveryDoc,
} from "./models";

type Schemas = {
  businesses: BusinessDoc;
  apiKeys: ApiKeyDoc;
  darajaAccounts: DarajaAccountDoc;
  transactions: TransactionDoc;
  paymentEvents: PaymentEventDoc;
  webhookDeliveries: WebhookDeliveryDoc;
  payoutCounters: PayoutCounterDoc;
  auditLogs: AuditLogDoc;
};

/** Which states a transaction may move from to reach each target. SUCCESS and FAILED are final. */
const ALLOWED_FROM: Record<TransactionStatus, TransactionStatus[]> = {
  REQUEST_RECEIVED: [],
  PROCESSING: ["REQUEST_RECEIVED"],
  UNKNOWN: ["REQUEST_RECEIVED", "PROCESSING"],
  SUCCESS: ["REQUEST_RECEIVED", "PROCESSING", "UNKNOWN"],
  FAILED: ["REQUEST_RECEIVED", "PROCESSING", "UNKNOWN"],
};

/** Fields a status transition or a provider response may set on a transaction. */
export type TransactionFields = Partial<
  Pick<
    Transaction,
    | "merchantRequestId"
    | "checkoutRequestId"
    | "conversationId"
    | "originatorConversationId"
    | "receipt"
    | "resultCode"
    | "resultDescription"
    | "reservedDay"
  >
>;

export type NewTransaction = {
  id: string;
  businessId: string;
  accountId: string;
  environment: Environment;
  type: TransactionType;
  direction: "IN" | "OUT";
  status: TransactionStatus;
  amount: number;
  idempotencyKey?: string;
  requestHash?: string;
  msisdn?: string;
  counterparty?: string;
  accountReference?: string;
  description?: string;
  commandId?: string;
  payerName?: string;
  receipt?: string;
  source: string;
};

export type TransitionResult = {
  applied: boolean;
  transaction: Transaction | null;
  /** Set when a final transaction received a contradictory outcome. */
  conflict?: boolean;
};

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value) || value.length !== 24) throw new Error("Invalid identifier.");
  return new ObjectId(value);
}

/** Convert a driver document into RPC-safe plain data. */
function plain<T>(doc: T): Plain<T> {
  return JSON.parse(JSON.stringify(doc)) as Plain<T>;
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/**
 * Owns a MongoDB client and is the only code that talks to the database.
 *
 * The Worker reaches it over Durable Object RPC, so a pooled connection is
 * reused across requests instead of reconnecting on every invocation. Every
 * method takes and returns plain data; Db/Collection/Cursor never leave here.
 * Tenant-owned reads always filter by businessId + environment.
 */
export class MongoDBConnection extends DurableObject<Env> {
  private client: MongoClient | null = null;
  private dbPromise: Promise<Db> | null = null;
  private indexesPromise: Promise<number> | null = null;

  private db(): Promise<Db> {
    if (!this.dbPromise) {
      if (!this.env.MONGODB_URI) return Promise.reject(new Error("MongoDB is not configured."));
      const client =
        this.client ??
        (this.client = new MongoClient(this.env.MONGODB_URI, {
          maxPoolSize: 4,
          minPoolSize: 0,
          serverSelectionTimeoutMS: 5_000,
          connectTimeoutMS: 5_000,
          maxIdleTimeMS: 30_000,
          retryReads: true,
          retryWrites: true,
          appName: "rotsi-payments",
        }));
      this.dbPromise = client
        .connect()
        .then(() => client.db(this.env.MONGODB_DATABASE || "rotsi_payments"))
        .catch((error: unknown) => {
          this.dbPromise = null;
          throw error;
        });
    }
    return this.dbPromise;
  }

  private async col<K extends keyof Schemas>(name: K): Promise<Collection<Schemas[K]>> {
    return (await this.db()).collection<Schemas[K]>(COLLECTIONS[name]);
  }

  // ---------------------------------------------------------------- health

  async ping(): Promise<{ status: "ok"; latencyMs: number }> {
    const started = Date.now();
    await (await this.db()).command({ ping: 1 });
    return { status: "ok", latencyMs: Date.now() - started };
  }

  /** Idempotent schema bootstrap. Run once per environment before traffic. */
  async initialize(): Promise<{ initialized: true; indexes: number }> {
    this.indexesPromise ??= this.createIndexes().catch((error: unknown) => {
      this.indexesPromise = null;
      throw error;
    });
    return { initialized: true, indexes: await this.indexesPromise };
  }

  private async createIndexes(): Promise<number> {
    const db = await this.db();
    const index = (name: string, spec: Document, options: Document) =>
      db.collection(name).createIndex(spec, options);
    const C = COLLECTIONS;
    const created = await Promise.all([
      index(C.businesses, { slug: 1 }, { unique: true, name: "uq_slug" }),

      index(C.apiKeys, { keyHash: 1 }, { unique: true, name: "uq_key_hash" }),
      index(C.apiKeys, { businessId: 1, environment: 1 }, { name: "ix_business_env" }),

      index(C.darajaAccounts, { businessId: 1, environment: 1 }, { unique: true, name: "uq_business_env" }),
      // Live shortcodes belong to exactly one tenant. Sandbox test shortcodes are shared.
      index(
        C.darajaAccounts,
        { environment: 1, shortcode: 1 },
        { unique: true, name: "uq_live_shortcode", partialFilterExpression: { environment: "production" } },
      ),

      index(
        C.transactions,
        { businessId: 1, environment: 1, idempotencyKey: 1 },
        { unique: true, name: "uq_idempotency", partialFilterExpression: { idempotencyKey: { $type: "string" } } },
      ),
      index(
        C.transactions,
        { environment: 1, type: 1, receipt: 1 },
        { unique: true, name: "uq_receipt", partialFilterExpression: { receipt: { $type: "string" } } },
      ),
      index(C.transactions, { businessId: 1, environment: 1, _id: -1 }, { name: "ix_tenant_list" }),
      index(C.transactions, { status: 1, updatedAt: 1 }, { name: "ix_reconcile" }),
      index(C.transactions, { environment: 1, receipt: 1 }, { name: "ix_receipt_lookup", sparse: true }),

      index(C.paymentEvents, { dedupKey: 1 }, { unique: true, name: "uq_dedup" }),
      index(C.paymentEvents, { transactionId: 1 }, { name: "ix_transaction", sparse: true }),

      index(C.webhookDeliveries, { status: 1, nextAttemptAt: 1 }, { name: "ix_due" }),
      index(C.webhookDeliveries, { businessId: 1, createdAt: -1 }, { name: "ix_business_created" }),

      index(C.auditLogs, { businessId: 1, createdAt: -1 }, { name: "ix_business_created" }),
    ]);
    return created.length;
  }

  // ------------------------------------------------------------ businesses

  async createBusiness(input: { id: string; name: string; slug: string }): Promise<Business | null> {
    const now = new Date();
    const doc: BusinessDoc = {
      _id: oid(input.id),
      name: input.name,
      slug: input.slug,
      status: "active",
      webhooks: {},
      createdAt: now,
      updatedAt: now,
    };
    try {
      await (await this.col("businesses")).insertOne(doc);
      return plain(doc);
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  }

  async getBusiness(id: string): Promise<Business | null> {
    const doc = await (await this.col("businesses")).findOne({ _id: oid(id) });
    return doc && plain(doc);
  }

  async setBusinessStatus(id: string, status: BusinessDoc["status"]): Promise<Business | null> {
    const doc = await (await this.col("businesses")).findOneAndUpdate(
      { _id: oid(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return doc && plain(doc);
  }

  async setBusinessWebhook(
    id: string,
    environment: Environment,
    webhook: { url: string; secret: Sealed } | null,
  ): Promise<boolean> {
    const update = webhook
      ? { $set: { [`webhooks.${environment}`]: webhook, updatedAt: new Date() } }
      : { $unset: { [`webhooks.${environment}`]: "" as const }, $set: { updatedAt: new Date() } };
    const result = await (await this.col("businesses")).updateOne({ _id: oid(id) }, update);
    return result.matchedCount === 1;
  }

  // -------------------------------------------------------------- api keys

  async createApiKey(input: {
    id: string;
    businessId: string;
    environment: Environment;
    name: string;
    prefix: string;
    keyHash: string;
    scopes: Scope[];
  }): Promise<ApiKey> {
    const doc: ApiKeyDoc = {
      _id: oid(input.id),
      businessId: oid(input.businessId),
      environment: input.environment,
      name: input.name,
      prefix: input.prefix,
      keyHash: input.keyHash,
      scopes: input.scopes,
      status: "active",
      createdAt: new Date(),
    };
    await (await this.col("apiKeys")).insertOne(doc);
    return plain(doc);
  }

  /** Resolve an API key hash to the key and its business in one round trip. */
  async authenticate(keyHash: string): Promise<{ key: ApiKey; business: Business } | null> {
    const key = await (await this.col("apiKeys")).findOne({ keyHash, status: "active" });
    if (!key) return null;
    const business = await (await this.col("businesses")).findOne({ _id: key.businessId });
    if (!business) return null;

    // Throttled last-used stamp: at most one write per key per 5 minutes.
    const stale = new Date(Date.now() - 5 * 60_000);
    void (await this.col("apiKeys"))
      .updateOne(
        { _id: key._id, $or: [{ lastUsedAt: { $exists: false } }, { lastUsedAt: { $lt: stale } }] },
        { $set: { lastUsedAt: new Date() } },
      )
      .catch(() => undefined);

    return { key: plain(key), business: plain(business) };
  }

  async listApiKeys(businessId: string): Promise<Omit<ApiKey, "keyHash">[]> {
    const docs = await (await this.col("apiKeys"))
      .find({ businessId: oid(businessId) }, { projection: { keyHash: 0 } })
      .sort({ _id: -1 })
      .limit(100)
      .toArray();
    return docs.map((doc) => plain(doc));
  }

  async revokeApiKey(businessId: string, keyId: string): Promise<boolean> {
    const result = await (await this.col("apiKeys")).updateOne(
      { _id: oid(keyId), businessId: oid(businessId), status: "active" },
      { $set: { status: "revoked", revokedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  // -------------------------------------------------------- daraja accounts

  /** Create or replace the M-Pesa account for a business + environment. */
  async upsertDarajaAccount(input: {
    businessId: string;
    environment: Environment;
    shortcode: string;
    shortcodeType: DarajaAccountDoc["shortcodeType"];
    tillNumber?: string;
    credentials: Sealed;
    limits: DarajaAccountDoc["limits"];
  }): Promise<DarajaAccount | "SHORTCODE_TAKEN"> {
    const now = new Date();
    try {
      const doc = await (await this.col("darajaAccounts")).findOneAndUpdate(
        { businessId: oid(input.businessId), environment: input.environment },
        {
          $set: {
            shortcode: input.shortcode,
            shortcodeType: input.shortcodeType,
            tillNumber: input.tillNumber,
            credentials: input.credentials,
            limits: input.limits,
            updatedAt: now,
          },
          // Re-submitting credentials never re-approves payouts on its own.
          $setOnInsert: { status: "active", payoutsEnabled: false, createdAt: now },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (!doc) throw new Error("Upsert returned no document.");
      return plain(doc);
    } catch (error) {
      if (isDuplicateKey(error)) return "SHORTCODE_TAKEN";
      throw error;
    }
  }

  async getDarajaAccount(id: string): Promise<DarajaAccount | null> {
    const doc = await (await this.col("darajaAccounts")).findOne({ _id: oid(id) });
    return doc && plain(doc);
  }

  async findDarajaAccount(businessId: string, environment: Environment): Promise<DarajaAccount | null> {
    const doc = await (await this.col("darajaAccounts")).findOne({
      businessId: oid(businessId),
      environment,
    });
    return doc && plain(doc);
  }

  async updateDarajaAccount(
    businessId: string,
    environment: Environment,
    patch: Partial<Pick<DarajaAccountDoc, "status" | "payoutsEnabled" | "limits" | "c2bRegisteredAt">>,
  ): Promise<DarajaAccount | null> {
    const doc = await (await this.col("darajaAccounts")).findOneAndUpdate(
      { businessId: oid(businessId), environment },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    return doc && plain(doc);
  }

  // ----------------------------------------------------------- transactions

  /**
   * Insert a transaction. A repeated idempotency key or receipt returns the
   * existing record with created=false instead of creating a duplicate.
   */
  async createTransaction(input: NewTransaction): Promise<{ created: boolean; transaction: Transaction }> {
    const now = new Date();
    const { id, businessId, accountId, source, ...rest } = input;
    const doc: TransactionDoc = {
      ...rest,
      _id: oid(id),
      businessId: oid(businessId),
      accountId: oid(accountId),
      currency: "KES",
      reconcileAttempts: 0,
      statusHistory: [{ status: input.status, at: now, source }],
      createdAt: now,
      updatedAt: now,
    };
    const transactions = await this.col("transactions");
    try {
      await transactions.insertOne(doc);
      return { created: true, transaction: plain(doc) };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await transactions.findOne(
        input.idempotencyKey
          ? { businessId: doc.businessId, environment: doc.environment, idempotencyKey: input.idempotencyKey }
          : { environment: doc.environment, type: doc.type, receipt: input.receipt },
      );
      if (!existing) throw error;
      return { created: false, transaction: plain(existing) };
    }
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    const doc = await (await this.col("transactions")).findOne({ _id: oid(id) });
    return doc && plain(doc);
  }

  /** Tenant-scoped read. Another tenant's id simply returns null. */
  async getTenantTransaction(id: string, businessId: string, environment: Environment): Promise<Transaction | null> {
    const doc = await (await this.col("transactions")).findOne({
      _id: oid(id),
      businessId: oid(businessId),
      environment,
    });
    return doc && plain(doc);
  }

  async findByReceipt(environment: Environment, receipt: string): Promise<Transaction | null> {
    const doc = await (await this.col("transactions")).findOne({ environment, receipt });
    return doc && plain(doc);
  }

  async listTransactions(input: {
    businessId: string;
    environment: Environment;
    limit: number;
    before?: string;
    type?: TransactionType;
    status?: TransactionStatus;
  }): Promise<Transaction[]> {
    const filter: Filter<TransactionDoc> = {
      businessId: oid(input.businessId),
      environment: input.environment,
    };
    if (input.before) filter._id = { $lt: oid(input.before) };
    if (input.type) filter.type = input.type;
    if (input.status) filter.status = input.status;
    const docs = await (await this.col("transactions"))
      .find(filter, { projection: { statusHistory: 0, requestHash: 0 } })
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(input.limit, 1), 100))
      .toArray();
    return docs.map((doc) => plain(doc));
  }

  async listForReview(limit: number): Promise<Transaction[]> {
    const docs = await (await this.col("transactions"))
      .find({ $or: [{ needsReview: true }, { status: "UNKNOWN" }] })
      .sort({ updatedAt: 1 })
      .limit(Math.min(limit, 200))
      .toArray();
    return docs.map((doc) => plain(doc));
  }

  /** Record provider references without changing status. Never overwrites an existing value. */
  async setTransactionRefs(id: string, fields: TransactionFields): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const transactions = await this.col("transactions");
    await Promise.all(
      entries.map(([key, value]) =>
        transactions.updateOne(
          { _id: oid(id), [key]: { $exists: false } },
          { $set: { [key]: value, updatedAt: new Date() } },
        ),
      ),
    );
  }

  /**
   * Atomic state-machine move. Applies only from an allowed state, so
   * concurrent callbacks, reconciliation and retries cannot double-apply.
   * Final records are never overwritten: a contradictory outcome is flagged
   * for review instead.
   */
  async transition(
    id: string,
    to: TransactionStatus,
    fields: TransactionFields,
    source: string,
  ): Promise<TransitionResult> {
    const transactions = await this.col("transactions");
    const now = new Date();
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

    try {
      const updated = await transactions.findOneAndUpdate(
        { _id: oid(id), status: { $in: ALLOWED_FROM[to] } },
        {
          $set: { ...set, status: to, updatedAt: now },
          $push: { statusHistory: { status: to, at: now, source } },
        },
        { returnDocument: "after" },
      );
      if (updated) return { applied: true, transaction: plain(updated) };
    } catch (error) {
      // Receipt already recorded on another transaction (e.g. STK + C2B for one payment).
      if (!isDuplicateKey(error)) throw error;
      const flagged = await transactions.findOneAndUpdate(
        { _id: oid(id), status: { $in: ALLOWED_FROM[to] } },
        {
          $set: {
            ...set,
            receipt: undefined,
            status: to,
            needsReview: true,
            reviewReason: `Receipt ${String(fields.receipt)} already recorded on another transaction.`,
            updatedAt: now,
          },
          $push: { statusHistory: { status: to, at: now, source } },
        },
        { returnDocument: "after", ignoreUndefined: true },
      );
      if (flagged) return { applied: true, transaction: plain(flagged) };
    }

    const current = await transactions.findOne({ _id: oid(id) });
    if (!current) return { applied: false, transaction: null };

    const isFinal = current.status === "SUCCESS" || current.status === "FAILED";
    const contradicts = isFinal && (to === "SUCCESS" || to === "FAILED") && current.status !== to;
    if (contradicts) {
      const flagged = await transactions.findOneAndUpdate(
        { _id: current._id },
        {
          $set: {
            needsReview: true,
            reviewReason: `Received ${to} from ${source} after the transaction was ${current.status}.`,
            updatedAt: now,
          },
        },
        { returnDocument: "after" },
      );
      return { applied: false, conflict: true, transaction: flagged && plain(flagged) };
    }

    // Same outcome reported again (duplicate callback, query after callback): fill gaps only.
    if (current.status === to) await this.setTransactionRefs(id, fields);
    return { applied: false, transaction: plain(current) };
  }

  async flagForReview(id: string, reason: string): Promise<void> {
    await (await this.col("transactions")).updateOne(
      { _id: oid(id) },
      { $set: { needsReview: true, reviewReason: reason, updatedAt: new Date() } },
    );
  }

  /** Transactions still in flight long enough to be worth asking Safaricom about. */
  async listForReconciliation(input: { olderThan: string; retryAfter: string; limit: number }): Promise<Transaction[]> {
    const docs = await (await this.col("transactions"))
      .find({
        status: { $in: ["PROCESSING", "UNKNOWN"] },
        updatedAt: { $lt: new Date(input.olderThan) },
        needsReview: { $ne: true },
        $or: [{ lastReconcileAt: { $exists: false } }, { lastReconcileAt: { $lt: new Date(input.retryAfter) } }],
      })
      .sort({ updatedAt: 1 })
      .limit(input.limit)
      .toArray();
    return docs.map((doc) => plain(doc));
  }

  async markReconcileAttempt(id: string): Promise<void> {
    await (await this.col("transactions")).updateOne(
      { _id: oid(id) },
      { $inc: { reconcileAttempts: 1 }, $set: { lastReconcileAt: new Date() } },
    );
  }

  // ---------------------------------------------------------- payout limits

  /** Atomically count a payout against the account's daily limit. */
  async reservePayout(accountId: string, day: string, amount: number, limit: number): Promise<boolean> {
    const counters = await this.col("payoutCounters");
    const _id = `${accountId}:${day}`;
    await counters.updateOne({ _id }, { $setOnInsert: { total: 0, updatedAt: new Date() } }, { upsert: true });
    const result = await counters.updateOne(
      { _id, total: { $lte: limit - amount } },
      { $inc: { total: amount }, $set: { updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }

  async releasePayout(accountId: string, day: string, amount: number): Promise<void> {
    await (await this.col("payoutCounters")).updateOne(
      { _id: `${accountId}:${day}` },
      { $inc: { total: -amount }, $set: { updatedAt: new Date() } },
    );
  }

  // --------------------------------------------------------- provider events

  /** Persist a raw callback. Returns false if this exact event was already stored. */
  async recordEvent(input: {
    dedupKey: string;
    kind: string;
    environment?: Environment;
    businessId?: string;
    accountId?: string;
    transactionId?: string;
    payload: unknown;
    payloadHash: string;
  }): Promise<boolean> {
    try {
      await (await this.col("paymentEvents")).insertOne({
        _id: new ObjectId(),
        dedupKey: input.dedupKey,
        kind: input.kind,
        environment: input.environment,
        businessId: input.businessId ? oid(input.businessId) : undefined,
        accountId: input.accountId ? oid(input.accountId) : undefined,
        transactionId: input.transactionId ? oid(input.transactionId) : undefined,
        payload: input.payload,
        payloadHash: input.payloadHash,
        receivedAt: new Date(),
      }, { ignoreUndefined: true });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  // ------------------------------------------------------- tenant webhooks

  /** Queue a webhook for the business's configured URL. Returns null if none is set. */
  async createWebhookDelivery(input: {
    businessId: string;
    environment: Environment;
    eventId: string;
    eventType: string;
    transactionId?: string;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    const business = await (await this.col("businesses")).findOne(
      { _id: oid(input.businessId) },
      { projection: { webhooks: 1 } },
    );
    const target = business?.webhooks?.[input.environment];
    if (!target) return null;

    const now = new Date();
    const id = new ObjectId();
    await (await this.col("webhookDeliveries")).insertOne({
      _id: id,
      businessId: oid(input.businessId),
      environment: input.environment,
      eventId: input.eventId,
      eventType: input.eventType,
      transactionId: input.transactionId ? oid(input.transactionId) : undefined,
      url: target.url,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }, { ignoreUndefined: true });
    return id.toHexString();
  }

  /** The delivery, its exact JSON body, and the business's sealed signing secret. */
  async getWebhookDelivery(
    id: string,
  ): Promise<{ delivery: Omit<WebhookDelivery, "payload">; body: string; secret: Sealed } | null> {
    const delivery = await (await this.col("webhookDeliveries")).findOne({ _id: oid(id) });
    if (!delivery) return null;
    const business = await (await this.col("businesses")).findOne(
      { _id: delivery.businessId },
      { projection: { webhooks: 1, status: 1 } },
    );
    const secret = business?.webhooks?.[delivery.environment]?.secret;
    if (!secret) return null;
    const { payload, ...rest } = delivery;
    return { delivery: plain(rest), body: JSON.stringify(payload), secret };
  }

  async recordWebhookAttempt(
    id: string,
    outcome: { status: WebhookDeliveryDoc["status"]; statusCode?: number; error?: string; retryInSeconds?: number },
  ): Promise<void> {
    const now = new Date();
    await (await this.col("webhookDeliveries")).updateOne(
      { _id: oid(id), status: "pending" },
      {
        $inc: { attempts: 1 },
        $set: {
          status: outcome.status,
          lastStatusCode: outcome.statusCode,
          lastError: outcome.error,
          nextAttemptAt: new Date(now.getTime() + (outcome.retryInSeconds ?? 0) * 1000),
          deliveredAt: outcome.status === "delivered" ? now : undefined,
          updatedAt: now,
        },
      },
      { ignoreUndefined: true },
    );
  }

  /** Pending deliveries whose queue message was evidently lost. Claims them by pushing nextAttemptAt. */
  async claimStuckDeliveries(olderThan: string, limit: number): Promise<string[]> {
    const deliveries = await this.col("webhookDeliveries");
    const docs = await deliveries
      .find({ status: "pending", nextAttemptAt: { $lt: new Date(olderThan) } }, { projection: { _id: 1 } })
      .limit(limit)
      .toArray();
    if (docs.length === 0) return [];
    const ids = docs.map((doc) => doc._id);
    await deliveries.updateMany(
      { _id: { $in: ids }, status: "pending" },
      { $set: { nextAttemptAt: new Date(Date.now() + 5 * 60_000), updatedAt: new Date() } },
    );
    return ids.map((value) => value.toHexString());
  }

  // ------------------------------------------------------------------ audit

  async audit(entry: {
    businessId?: string;
    actorType: AuditLogDoc["actorType"];
    actorId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: AuditLogDoc["metadata"];
  }): Promise<void> {
    await (await this.col("auditLogs")).insertOne({
      ...entry,
      _id: new ObjectId(),
      businessId: entry.businessId ? oid(entry.businessId) : undefined,
      createdAt: new Date(),
    }, { ignoreUndefined: true });
  }
}

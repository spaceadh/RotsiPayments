import {
  MongoServerError,
  ObjectId,
  type Db,
} from "mongodb";
import { COLLECTIONS } from "./collections";
import type {
  ApiKeyDocument,
  AuditLogDocument,
  BusinessDocument,
  PaymentEventDocument,
  TransactionDocument,
  WebhookDeliveryDocument,
} from "./models";

function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

export class BusinessesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<BusinessDocument>(COLLECTIONS.businesses);
  }

  async create(input: Pick<BusinessDocument, "name" | "slug" | "status">): Promise<string> {
    const now = new Date();
    const result = await this.collection.insertOne({
      ...input,
      _id: new ObjectId(),
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId.toHexString();
  }

  async findById(id: string): Promise<BusinessDocument | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    return this.collection.findOne({ _id: objectId });
  }
}

export class ApiKeysRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<ApiKeyDocument>(COLLECTIONS.apiKeys);
  }

  async findActiveByHash(keyHash: string): Promise<ApiKeyDocument | null> {
    return this.collection.findOne({ keyHash, status: "active" });
  }

  async markUsed(id: string): Promise<void> {
    const objectId = toObjectId(id);
    if (!objectId) return;
    await this.collection.updateOne(
      { _id: objectId, status: "active" },
      { $set: { lastUsedAt: new Date() } },
    );
  }
}

export class TransactionsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<TransactionDocument>(COLLECTIONS.transactions);
  }

  async findByIdForBusiness(id: string, businessId: string): Promise<TransactionDocument | null> {
    const transactionObjectId = toObjectId(id);
    const businessObjectId = toObjectId(businessId);
    if (!transactionObjectId || !businessObjectId) return null;

    return this.collection.findOne({
      _id: transactionObjectId,
      businessId: businessObjectId,
    });
  }

  async findByIdempotencyKey(
    businessId: string,
    idempotencyKey: string,
  ): Promise<TransactionDocument | null> {
    const businessObjectId = toObjectId(businessId);
    if (!businessObjectId) return null;
    return this.collection.findOne({ businessId: businessObjectId, idempotencyKey });
  }

  async create(
    input: Pick<
      TransactionDocument,
      "businessId" | "type" | "status" | "amount" | "currency" | "idempotencyKey" | "provider"
    > &
      Partial<
        Pick<
          TransactionDocument,
          | "providerConversationId"
          | "providerOriginatorConversationId"
          | "providerTransactionId"
          | "resultCode"
          | "resultDescription"
        >
      >,
  ): Promise<string> {
    const now = new Date();
    const result = await this.collection.insertOne({
      ...input,
      _id: new ObjectId(),
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId.toHexString();
  }
}

export class PaymentEventsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<PaymentEventDocument>(COLLECTIONS.paymentEvents);
  }

  async insertOnce(
    input: Pick<
      PaymentEventDocument,
      "deduplicationKey" | "provider" | "eventType" | "payloadHash" | "receivedAt"
    > &
      Partial<Pick<PaymentEventDocument, "transactionId" | "businessId">>,
  ): Promise<boolean> {
    try {
      await this.collection.insertOne({ ...input, _id: new ObjectId() });
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        return false;
      }
      throw error;
    }
  }
}

export class WebhookDeliveriesRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<WebhookDeliveryDocument>(COLLECTIONS.webhookDeliveries);
  }

  async create(
    input: Pick<
      WebhookDeliveryDocument,
      "businessId" | "eventId" | "targetUrl" | "status" | "attempts" | "nextAttemptAt"
    > &
      Partial<Pick<WebhookDeliveryDocument, "lastStatusCode">>,
  ): Promise<string> {
    const now = new Date();
    const result = await this.collection.insertOne({
      ...input,
      _id: new ObjectId(),
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId.toHexString();
  }
}

export class AuditLogsRepository {
  private readonly collection;

  constructor(db: Db) {
    this.collection = db.collection<AuditLogDocument>(COLLECTIONS.auditLogs);
  }

  async append(
    input: Pick<AuditLogDocument, "actorType" | "action" | "resourceType"> &
      Partial<
        Pick<AuditLogDocument, "businessId" | "actorId" | "resourceId" | "metadata">
      >,
  ): Promise<string> {
    const result = await this.collection.insertOne({
      ...input,
      _id: new ObjectId(),
      createdAt: new Date(),
    });
    return result.insertedId.toHexString();
  }
}

export class MongoRepositories {
  readonly businesses: BusinessesRepository;
  readonly apiKeys: ApiKeysRepository;
  readonly transactions: TransactionsRepository;
  readonly paymentEvents: PaymentEventsRepository;
  readonly webhookDeliveries: WebhookDeliveriesRepository;
  readonly auditLogs: AuditLogsRepository;

  constructor(db: Db) {
    this.businesses = new BusinessesRepository(db);
    this.apiKeys = new ApiKeysRepository(db);
    this.transactions = new TransactionsRepository(db);
    this.paymentEvents = new PaymentEventsRepository(db);
    this.webhookDeliveries = new WebhookDeliveriesRepository(db);
    this.auditLogs = new AuditLogsRepository(db);
  }

  async ensureIndexes(db: Db): Promise<string[]> {
    const created = await Promise.all([
      db.collection(COLLECTIONS.businesses).createIndex(
        { slug: 1 },
        { unique: true, name: "uq_business_slug" },
      ),
      db.collection(COLLECTIONS.apiKeys).createIndex(
        { keyHash: 1 },
        { unique: true, name: "uq_api_key_hash" },
      ),
      db.collection(COLLECTIONS.apiKeys).createIndex(
        { businessId: 1, status: 1 },
        { name: "ix_api_keys_business_status" },
      ),
      db.collection(COLLECTIONS.transactions).createIndex(
        { businessId: 1, idempotencyKey: 1 },
        { unique: true, name: "uq_transactions_business_idempotency" },
      ),
      db.collection(COLLECTIONS.transactions).createIndex(
        { businessId: 1, createdAt: -1 },
        { name: "ix_transactions_business_created" },
      ),
      db.collection(COLLECTIONS.transactions).createIndex(
        { providerConversationId: 1 },
        { unique: true, sparse: true, name: "uq_transactions_provider_conversation" },
      ),
      db.collection(COLLECTIONS.paymentEvents).createIndex(
        { deduplicationKey: 1 },
        { unique: true, name: "uq_payment_events_deduplication" },
      ),
      db.collection(COLLECTIONS.webhookDeliveries).createIndex(
        { status: 1, nextAttemptAt: 1 },
        { name: "ix_webhook_deliveries_due" },
      ),
      db.collection(COLLECTIONS.webhookDeliveries).createIndex(
        { businessId: 1, createdAt: -1 },
        { name: "ix_webhook_deliveries_business_created" },
      ),
      db.collection(COLLECTIONS.auditLogs).createIndex(
        { businessId: 1, createdAt: -1 },
        { name: "ix_audit_logs_business_created" },
      ),
    ]);

    return created;
  }
}

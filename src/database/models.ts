import type { Document, ObjectId } from "mongodb";

export type BusinessStatus = "pending" | "active" | "suspended";
export type ApiKeyStatus = "active" | "revoked";
export type TransactionType = "C2B" | "B2B";
export type TransactionStatus =
  | "REQUEST_RECEIVED"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "UNKNOWN";

export interface BusinessDocument extends Document {
  _id: ObjectId;
  name: string;
  slug: string;
  status: BusinessStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyDocument extends Document {
  _id: ObjectId;
  businessId: ObjectId;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  status: ApiKeyStatus;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface TransactionDocument extends Document {
  _id: ObjectId;
  businessId: ObjectId;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  currency: "KES";
  idempotencyKey: string;
  provider: "safaricom";
  providerConversationId?: string;
  providerOriginatorConversationId?: string;
  providerTransactionId?: string;
  resultCode?: string;
  resultDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEventDocument extends Document {
  _id: ObjectId;
  deduplicationKey: string;
  provider: "safaricom";
  eventType: string;
  transactionId?: ObjectId;
  businessId?: ObjectId;
  payloadHash: string;
  receivedAt: Date;
}

export interface WebhookDeliveryDocument extends Document {
  _id: ObjectId;
  businessId: ObjectId;
  eventId: ObjectId;
  targetUrl: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastStatusCode?: number;
}

export interface AuditLogDocument extends Document {
  _id: ObjectId;
  businessId?: ObjectId;
  actorType: "system" | "business" | "admin";
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

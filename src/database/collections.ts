export const COLLECTIONS = {
  businesses: "businesses",
  apiKeys: "api_keys",
  transactions: "transactions",
  paymentEvents: "payment_events",
  webhookDeliveries: "webhook_deliveries",
  auditLogs: "audit_logs",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export const COLLECTIONS = {
  businesses: "payments_businesses",
  apiKeys: "payments_api_keys",
  transactions: "payments_transactions",
  paymentEvents: "payments_payment_events",
  webhookDeliveries: "payments_webhook_deliveries",
  auditLogs: "payments_audit_logs",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

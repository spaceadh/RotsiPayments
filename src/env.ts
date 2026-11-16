import type { MongoDBConnection } from "./db/store";

export type Environment = "sandbox" | "production";

export type WebhookMessage = { deliveryId: string };

/**
 * Cloudflare Worker bindings.
 *
 * Secrets (MONGODB_URI, MASTER_KEY, INTERNAL_ADMIN_TOKEN) are configured with
 * `wrangler secret put` and must never be committed to source control.
 */
export interface Env {
  APP_ENV?: string;

  // MongoDB Atlas, reached through Durable Objects that own the driver.
  MONGODB_URI: string;
  MONGODB_DATABASE?: string;
  /** Number of connection-owning Durable Objects to spread load across. */
  MONGODB_SHARDS?: string;
  /** Optional DO location hint, e.g. "weur" or "afr", close to the Atlas cluster. */
  MONGODB_LOCATION_HINT?: string;
  MONGODB_CONNECTION: DurableObjectNamespace<MongoDBConnection>;

  /** 32+ random bytes, base64. Every other key is derived from it with HKDF. */
  MASTER_KEY?: string;
  /** Bearer token for /v1/admin. Put Cloudflare Access in front in production. */
  INTERNAL_ADMIN_TOKEN?: string;

  /** Public origin Safaricom calls back to, e.g. https://api.rotsi.co.ke */
  PUBLIC_BASE_URL: string;
  /** Kill switch for live money movement. Anything but "true" blocks live keys. */
  LIVE_PAYMENTS_ENABLED?: string;
  /** Optional comma-separated Safaricom callback IPs. Empty = not enforced. */
  DARAJA_CALLBACK_IPS?: string;

  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  API_RATE_LIMITER?: RateLimit;
}

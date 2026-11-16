import type { MongoDBConnection } from "./database/mongo-connection";

/**
 * Cloudflare Worker bindings.
 *
 * Credentials are configured as Cloudflare secrets and must never be
 * committed to source control.
 */
export interface Env {
  APP_ENV?: "development" | "sandbox" | "production";

  MONGODB_URI: string;
  MONGODB_DATABASE?: string;
  MONGODB_CONNECTION: DurableObjectNamespace<MongoDBConnection>;
  INTERNAL_ADMIN_TOKEN?: string;

  DARAJA_ENV: "sandbox" | "production";
  DARAJA_CONSUMER_KEY: string;
  DARAJA_CONSUMER_SECRET: string;
}

/**
 * Cloudflare Worker bindings.
 *
 * Values containing credentials must be configured as Cloudflare secrets,
 * never committed to source control.
 */
export interface Env {
  APP_ENV?: "development" | "sandbox" | "production";

  MONGODB_URI: string;

  DARAJA_ENV: "sandbox" | "production";
  DARAJA_CONSUMER_KEY: string;
  DARAJA_CONSUMER_SECRET: string;
}

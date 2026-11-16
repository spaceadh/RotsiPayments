import { createMiddleware } from "hono/factory";
import { getStore } from "../db/client";
import type { Scope } from "../db/models";
import type { Env, Environment } from "../env";
import { constantTimeEqual, hashApiKey } from "../lib/crypto";
import { AppError } from "../lib/http";
import type { Tenant } from "../services/payments";

export type AppEnv = { Bindings: Env; Variables: { tenant: Tenant } };

const API_KEY = /^rk_(live|test)_[A-Za-z0-9_-]{43}$/;
const AUTH_CACHE_MS = 30_000;
const authCache = new Map<string, { expiresAt: number; tenant: Tenant | null }>();

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function rateLimit(env: Env, key: string): Promise<void> {
  if (!env.API_RATE_LIMITER) return;
  const { success } = await env.API_RATE_LIMITER.limit({ key });
  if (!success) throw new AppError(429, "RATE_LIMITED", "Too many requests. Slow down and retry.");
}

/**
 * Tenant authentication: `Authorization: Bearer rk_test_...` or `rk_live_...`.
 * The key prefix decides the environment, so a test key can never touch live
 * money. Results are cached per isolate for 30s (revocation takes <=30s).
 */
export const tenantAuth = createMiddleware<AppEnv>(async (c, next) => {
  const apiKey = bearer(c.req.header("authorization"));
  const match = API_KEY.exec(apiKey);
  if (!match) throw new AppError(401, "UNAUTHORIZED", "A valid API key is required.");

  const keyHash = await hashApiKey(c.env, apiKey);
  let cached = authCache.get(keyHash);
  if (!cached || cached.expiresAt < Date.now()) {
    const found = await getStore(c.env).authenticate(keyHash);
    const environment: Environment = match[1] === "live" ? "production" : "sandbox";
    const tenant =
      found && found.business.status === "active" && found.key.environment === environment
        ? {
            apiKeyId: found.key._id,
            businessId: found.business._id,
            environment,
            scopes: found.key.scopes,
          }
        : null;
    cached = { expiresAt: Date.now() + AUTH_CACHE_MS, tenant };
    authCache.set(keyHash, cached);
    if (authCache.size > 5_000) authCache.clear();
  }
  if (!cached.tenant) throw new AppError(401, "UNAUTHORIZED", "A valid API key is required.");

  await rateLimit(c.env, `key:${cached.tenant.apiKeyId}`);
  c.set("tenant", cached.tenant);
  await next();
});

export function requireScope(scope: Scope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("tenant").scopes.includes(scope)) {
      throw new AppError(403, "FORBIDDEN", `This API key lacks the ${scope} scope.`);
    }
    await next();
  });
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

/** Every money-moving request must carry an Idempotency-Key. */
export function idempotencyKey(header: string | undefined): string {
  if (!header || !IDEMPOTENCY_KEY.test(header)) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send an Idempotency-Key header (8-100 chars: letters, digits, _ . : -).",
    );
  }
  return header;
}

/** Admin authentication. In production, also put Cloudflare Access in front of /v1/admin. */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.env.INTERNAL_ADMIN_TOKEN;
  if (!expected || expected.length < 32) {
    throw new AppError(503, "ADMIN_NOT_CONFIGURED", "Administration is not enabled.");
  }
  await rateLimit(c.env, `admin:${c.req.header("cf-connecting-ip") ?? "unknown"}`);
  if (!constantTimeEqual(bearer(c.req.header("authorization")), expected)) {
    throw new AppError(401, "UNAUTHORIZED", "A valid admin token is required.");
  }
  await next();
});

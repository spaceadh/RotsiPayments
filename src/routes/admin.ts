import { Hono } from "hono";
import { z } from "zod";
import { getStore } from "../db/client";
import { SCOPES } from "../db/models";
import type { Environment } from "../env";
import { hashApiKey, randomToken, seal } from "../lib/crypto";
import { AppError, ok, parse, readJson } from "../lib/http";
import { fromPublicId, newId, toPublicId } from "../lib/ids";
import { forgetAccount, sealCredentials, webhookSecretContext } from "../services/accounts";
import { transactionView } from "../services/events";
import { registerC2B } from "../services/payments";
import { adminAuth, type AppEnv } from "./middleware";

/**
 * Operator API for onboarding businesses. Secrets (API keys, webhook
 * secrets) are returned exactly once and stored only as hashes/ciphertext.
 */
export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", adminAuth);

const environmentSchema = z.enum(["sandbox", "production"]);

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    const host = url.hostname;
    const isIp = /^[\d.]+$/.test(host) || host.includes(":");
    return url.protocol === "https:" && !isIp && host !== "localhost" && !host.endsWith(".local") && !url.username;
  }, "Must be a public https URL with a hostname.");

function businessIdParam(value: string): string {
  const id = fromPublicId("business", value);
  if (!id) throw new AppError(404, "NOT_FOUND", "Business not found.");
  return id;
}

function environmentParam(value: string): Environment {
  return parse(environmentSchema, value);
}

async function audit(
  c: { env: AppEnv["Bindings"] },
  action: string,
  resourceType: string,
  businessId?: string,
  resourceId?: string,
  metadata?: Record<string, string | number | boolean | null>,
) {
  await getStore(c.env).audit({ actorType: "admin", action, resourceType, businessId, resourceId, metadata });
}

adminRoutes.post("/database/initialize", async (c) => {
  return c.json(ok(await getStore(c.env).initialize()));
});

// ------------------------------------------------------------- businesses

adminRoutes.post("/businesses", async (c) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(2).max(120),
      slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, "Lowercase letters, digits and dashes."),
    }),
    await readJson(c.req.raw),
  );
  const business = await getStore(c.env).createBusiness({ id: newId(), ...input });
  if (!business) throw new AppError(409, "SLUG_TAKEN", "A business with this slug already exists.");
  await audit(c, "business.created", "business", business._id, business._id);
  return c.json(ok({ id: toPublicId("business", business._id), name: business.name, slug: business.slug, status: business.status }), 201);
});

adminRoutes.get("/businesses/:businessId", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const store = getStore(c.env);
  const [business, sandbox, production, keys] = await Promise.all([
    store.getBusiness(id),
    store.findDarajaAccount(id, "sandbox"),
    store.findDarajaAccount(id, "production"),
    store.listApiKeys(id),
  ]);
  if (!business) throw new AppError(404, "NOT_FOUND", "Business not found.");
  const accountView = (a: typeof sandbox) =>
    a && {
      id: toPublicId("account", a._id),
      shortcode: a.shortcode,
      shortcodeType: a.shortcodeType,
      status: a.status,
      payoutsEnabled: a.payoutsEnabled,
      limits: a.limits,
      c2bRegisteredAt: a.c2bRegisteredAt ?? null,
    };
  return c.json(
    ok({
      id: toPublicId("business", business._id),
      name: business.name,
      slug: business.slug,
      status: business.status,
      webhooks: {
        sandbox: business.webhooks.sandbox?.url ?? null,
        production: business.webhooks.production?.url ?? null,
      },
      mpesa: { sandbox: accountView(sandbox), production: accountView(production) },
      apiKeys: keys.map((k) => ({
        id: toPublicId("apiKey", k._id),
        name: k.name,
        prefix: k.prefix,
        environment: k.environment,
        scopes: k.scopes,
        status: k.status,
        lastUsedAt: k.lastUsedAt ?? null,
      })),
    }),
  );
});

adminRoutes.patch("/businesses/:businessId", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const { status } = parse(z.object({ status: z.enum(["active", "suspended"]) }), await readJson(c.req.raw));
  const business = await getStore(c.env).setBusinessStatus(id, status);
  if (!business) throw new AppError(404, "NOT_FOUND", "Business not found.");
  await audit(c, `business.${status}`, "business", id, id);
  return c.json(ok({ id: toPublicId("business", id), status: business.status }));
});

// ---------------------------------------------------------------- webhooks

/** Set or rotate the tenant webhook. Returns the signing secret once. */
adminRoutes.put("/businesses/:businessId/webhooks/:environment", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const environment = environmentParam(c.req.param("environment"));
  const { url } = parse(z.object({ url: httpsUrl }), await readJson(c.req.raw));
  const secret = `whsec_${randomToken(32)}`;
  const sealed = await seal(c.env, secret, webhookSecretContext(id, environment));
  if (!(await getStore(c.env).setBusinessWebhook(id, environment, { url, secret: sealed }))) {
    throw new AppError(404, "NOT_FOUND", "Business not found.");
  }
  await audit(c, "webhook.configured", "business", id, id, { environment });
  return c.json(ok({ url, environment, secret }, "Store this secret now; it will not be shown again."));
});

adminRoutes.delete("/businesses/:businessId/webhooks/:environment", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const environment = environmentParam(c.req.param("environment"));
  await getStore(c.env).setBusinessWebhook(id, environment, null);
  await audit(c, "webhook.removed", "business", id, id, { environment });
  return c.json(ok({ removed: true }));
});

// ---------------------------------------------------------------- API keys

adminRoutes.post("/businesses/:businessId/api-keys", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const input = parse(
    z.object({
      environment: environmentSchema,
      name: z.string().trim().min(1).max(60).default("default"),
      scopes: z.array(z.enum(SCOPES)).min(1).default(["payments:read", "payments:write"]),
    }),
    await readJson(c.req.raw),
  );
  const store = getStore(c.env);
  if (!(await store.getBusiness(id))) throw new AppError(404, "NOT_FOUND", "Business not found.");

  const apiKey = `rk_${input.environment === "production" ? "live" : "test"}_${randomToken(32)}`;
  const key = await store.createApiKey({
    id: newId(),
    businessId: id,
    environment: input.environment,
    name: input.name,
    prefix: apiKey.slice(0, 12),
    keyHash: await hashApiKey(c.env, apiKey),
    scopes: [...new Set(input.scopes)],
  });
  await audit(c, "api_key.created", "api_key", id, key._id, { environment: input.environment, scopes: key.scopes.join(",") });
  return c.json(
    ok(
      { id: toPublicId("apiKey", key._id), apiKey, environment: key.environment, scopes: key.scopes },
      "Store this key now; it will not be shown again.",
    ),
    201,
  );
});

adminRoutes.delete("/businesses/:businessId/api-keys/:keyId", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const keyId = fromPublicId("apiKey", c.req.param("keyId"));
  if (!keyId || !(await getStore(c.env).revokeApiKey(id, keyId))) {
    throw new AppError(404, "NOT_FOUND", "Active API key not found.");
  }
  await audit(c, "api_key.revoked", "api_key", id, keyId);
  return c.json(ok({ revoked: true }, "Revocation takes effect within 30 seconds."));
});

// ------------------------------------------------------------ M-Pesa setup

const accountSchema = z.object({
  shortcode: z.string().regex(/^\d{5,7}$/),
  shortcodeType: z.enum(["paybill", "till"]),
  tillNumber: z.string().regex(/^\d{5,8}$/).optional(),
  consumerKey: z.string().min(10).max(200),
  consumerSecret: z.string().min(10).max(200),
  passkey: z.string().min(10).max(200).optional(),
  initiatorName: z.string().min(1).max(100).optional(),
  securityCredential: z.string().min(20).max(2000).optional(),
  limits: z
    .object({
      maxTransactionAmount: z.number().int().min(1).max(999_999_999),
      dailyPayoutLimit: z.number().int().min(0).max(9_999_999_999),
    })
    .default({ maxTransactionAmount: 150_000, dailyPayoutLimit: 300_000 }),
});

/** Create or replace a business's Daraja credentials for one environment. */
adminRoutes.put("/businesses/:businessId/mpesa/:environment", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const environment = environmentParam(c.req.param("environment"));
  const input = parse(accountSchema, await readJson(c.req.raw));
  const store = getStore(c.env);
  if (!(await store.getBusiness(id))) throw new AppError(404, "NOT_FOUND", "Business not found.");

  const credentials = await sealCredentials(c.env, id, environment, {
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
    passkey: input.passkey,
    initiatorName: input.initiatorName,
    securityCredential: input.securityCredential,
  });
  const account = await store.upsertDarajaAccount({
    businessId: id,
    environment,
    shortcode: input.shortcode,
    shortcodeType: input.shortcodeType,
    tillNumber: input.tillNumber,
    credentials,
    limits: input.limits,
  });
  if (account === "SHORTCODE_TAKEN") {
    throw new AppError(409, "SHORTCODE_TAKEN", "This live shortcode belongs to another business.");
  }
  forgetAccount(id, environment);
  await audit(c, "mpesa.configured", "daraja_account", id, account._id, { environment, shortcode: input.shortcode });
  return c.json(
    ok({
      id: toPublicId("account", account._id),
      environment,
      shortcode: account.shortcode,
      status: account.status,
      payoutsEnabled: account.payoutsEnabled,
      products: {
        stkPush: Boolean(input.passkey),
        payouts: Boolean(input.initiatorName && input.securityCredential),
      },
    }),
  );
});

/** Approve payouts, disable an account, or change limits. */
adminRoutes.patch("/businesses/:businessId/mpesa/:environment", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const environment = environmentParam(c.req.param("environment"));
  const patch = parse(
    z
      .object({
        status: z.enum(["active", "disabled"]).optional(),
        payoutsEnabled: z.boolean().optional(),
        limits: accountSchema.shape.limits.unwrap().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, "Nothing to update."),
    await readJson(c.req.raw),
  );
  const account = await getStore(c.env).updateDarajaAccount(id, environment, patch);
  if (!account) throw new AppError(404, "NOT_FOUND", "M-Pesa account not found.");
  forgetAccount(id, environment);
  await audit(c, "mpesa.updated", "daraja_account", id, account._id, {
    environment,
    status: account.status,
    payoutsEnabled: account.payoutsEnabled,
  });
  return c.json(ok({ status: account.status, payoutsEnabled: account.payoutsEnabled, limits: account.limits }));
});

/** Register Rotsi's signed C2B confirmation/validation URLs for the shortcode. */
adminRoutes.post("/businesses/:businessId/mpesa/:environment/c2b/register", async (c) => {
  const id = businessIdParam(c.req.param("businessId"));
  const environment = environmentParam(c.req.param("environment"));
  const { responseType } = parse(
    z.object({ responseType: z.enum(["Completed", "Cancelled"]).default("Completed") }),
    await readJson(c.req.raw).catch(() => ({})),
  );
  const result = await registerC2B(c.env, id, environment, responseType);
  await audit(c, "mpesa.c2b_registered", "daraja_account", id, undefined, { environment });
  return c.json(ok(result));
});

// ---------------------------------------------------------- investigation

adminRoutes.get("/review", async (c) => {
  const items = await getStore(c.env).listForReview(100);
  return c.json(
    ok(items.map((t) => ({ ...transactionView(t), businessId: toPublicId("business", t.businessId), reviewReason: t.reviewReason }))),
  );
});

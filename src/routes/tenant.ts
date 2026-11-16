import { Hono } from "hono";
import { z } from "zod";
import { getStore } from "../db/client";
import { AppError, ok, parse, readJson } from "../lib/http";
import { fromPublicId, toPublicId } from "../lib/ids";
import { normalizeMsisdn } from "../lib/phone";
import { transactionView } from "../services/events";
import { b2bPayment, b2cPayment, simulateC2B, stkPush } from "../services/payments";
import { idempotencyKey, requireScope, tenantAuth, type AppEnv } from "./middleware";

const phone = z
  .string()
  .transform((value, ctx) => {
    const msisdn = normalizeMsisdn(value);
    if (!msisdn) {
      ctx.addIssue({ code: "custom", message: "Use a Kenyan mobile number, e.g. 0712345678 or 254712345678." });
      return z.NEVER;
    }
    return msisdn;
  });

// M-Pesa moves whole shillings.
const amount = z.number().int("Amount must be a whole number of shillings.").min(1).max(999_999_999);
const shortcode = z.string().regex(/^\d{5,7}$/, "Shortcodes are 5-7 digits.");
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[\w .,:#/-]+$/, "Use letters, digits and basic punctuation.");

const stkSchema = z.object({
  phone,
  amount: amount.max(250_000),
  accountReference: text(12),
  description: text(13),
});

const b2cSchema = z.object({
  phone,
  amount: amount.max(250_000),
  commandId: z.enum(["BusinessPayment", "SalaryPayment", "PromotionPayment"]).default("BusinessPayment"),
  remarks: text(100),
  occasion: text(100).optional(),
});

const b2bSchema = z
  .object({
    receiverShortcode: shortcode,
    receiverType: z.enum(["paybill", "till"]),
    accountReference: text(13).optional(),
    amount,
    remarks: text(100),
  })
  .refine((v) => v.receiverType === "till" || v.accountReference, {
    message: "accountReference is required when paying a paybill.",
    path: ["accountReference"],
  })
  .transform((v) => ({ ...v, accountReference: v.accountReference ?? v.receiverShortcode }));

const simulateSchema = z.object({
  phone: phone.default("254708374149"),
  amount: amount.max(250_000),
  billRef: text(20).default("TEST"),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
  type: z.enum(["C2B", "STK_PUSH", "B2C", "B2B"]).optional(),
  status: z.enum(["REQUEST_RECEIVED", "PROCESSING", "SUCCESS", "FAILED", "UNKNOWN"]).optional(),
});

export const tenantRoutes = new Hono<AppEnv>();

tenantRoutes.use("*", tenantAuth);

tenantRoutes.get("/businesses/me", async (c) => {
  const tenant = c.get("tenant");
  const business = await getStore(c.env).getBusiness(tenant.businessId);
  if (!business) throw new AppError(404, "NOT_FOUND", "Business not found.");
  const account = await getStore(c.env).findDarajaAccount(tenant.businessId, tenant.environment);
  return c.json(
    ok({
      id: toPublicId("business", business._id),
      name: business.name,
      status: business.status,
      environment: tenant.environment,
      scopes: tenant.scopes,
      webhookUrl: business.webhooks[tenant.environment]?.url ?? null,
      mpesa: account
        ? {
            shortcode: account.shortcode,
            shortcodeType: account.shortcodeType,
            status: account.status,
            payoutsEnabled: account.payoutsEnabled,
            limits: account.limits,
            c2bRegistered: Boolean(account.c2bRegisteredAt),
          }
        : null,
    }),
  );
});

/** STK Push (Lipa na M-Pesa Online): prompt a customer's phone to pay. */
tenantRoutes.post("/stk-push", requireScope("payments:write"), async (c) => {
  const key = idempotencyKey(c.req.header("idempotency-key"));
  const input = parse(stkSchema, await readJson(c.req.raw));
  const { transaction, replay } = await stkPush(c.env, c.get("tenant"), input, key);
  return c.json(ok(transactionView(transaction), replay ? "Idempotent replay" : "STK push sent"), replay ? 200 : 202);
});

/** B2C: pay out to a customer's M-Pesa wallet. */
tenantRoutes.post("/b2c/payments", requireScope("payouts:write"), async (c) => {
  const key = idempotencyKey(c.req.header("idempotency-key"));
  const input = parse(b2cSchema, await readJson(c.req.raw));
  const { transaction, replay } = await b2cPayment(c.env, c.get("tenant"), input, key);
  return c.json(ok(transactionView(transaction), replay ? "Idempotent replay" : "Payout accepted"), replay ? 200 : 202);
});

/** B2B: pay another business's paybill or till. */
tenantRoutes.post("/b2b/payments", requireScope("payouts:write"), async (c) => {
  const key = idempotencyKey(c.req.header("idempotency-key"));
  const input = parse(b2bSchema, await readJson(c.req.raw));
  const { transaction, replay } = await b2bPayment(c.env, c.get("tenant"), input, key);
  return c.json(ok(transactionView(transaction), replay ? "Idempotent replay" : "Payment accepted"), replay ? 200 : 202);
});

/** Sandbox only: trigger a C2B payment to your registered URLs. */
tenantRoutes.post("/c2b/simulate", requireScope("payments:write"), async (c) => {
  const input = parse(simulateSchema, await readJson(c.req.raw));
  return c.json(ok(await simulateC2B(c.env, c.get("tenant"), input), "Simulation requested"), 202);
});

tenantRoutes.get("/transactions/:id", requireScope("payments:read"), async (c) => {
  const tenant = c.get("tenant");
  const id = fromPublicId("transaction", c.req.param("id"));
  const transaction = id && (await getStore(c.env).getTenantTransaction(id, tenant.businessId, tenant.environment));
  if (!transaction) throw new AppError(404, "NOT_FOUND", "Transaction not found.");
  return c.json(ok(transactionView(transaction)));
});

tenantRoutes.get("/transactions", requireScope("payments:read"), async (c) => {
  const tenant = c.get("tenant");
  const query = parse(listSchema, c.req.query());
  const before = query.before ? fromPublicId("transaction", query.before) : undefined;
  if (before === null) throw new AppError(422, "VALIDATION_FAILED", "Invalid cursor.");
  const items = await getStore(c.env).listTransactions({
    businessId: tenant.businessId,
    environment: tenant.environment,
    limit: query.limit,
    before,
    type: query.type,
    status: query.status,
  });
  const last = items.at(-1);
  return c.json(
    ok({
      items: items.map(transactionView),
      nextCursor: items.length === query.limit && last ? toPublicId("transaction", last._id) : null,
    }),
  );
});

# agent.md — Rotsi Payments engineering log

The running log for humans and AI agents working on this repo. **Read it before
changing anything, then add an entry when you finish.** Newest entries go at the top
of the Log. Keep entries short and factual: what changed, why, how it was verified,
and what is still open.

---

## Ground rules (do not break these)

1. **Integrators never see Daraja.** Tenants call `/v1/*` with an API key. They never
   touch Safaricom credentials, shortcode registration, or callback formats.
2. **MongoDB is the ledger of record** between Safaricom and every paybill/till on
   the platform. Final states (`SUCCESS`, `FAILED`) are never overwritten. A
   contradictory later outcome sets `needsReview` instead.
3. **Never auto-retry money movement.** A timeout or 5xx from Daraja means `UNKNOWN`.
   Reconciliation *asks* Safaricom (STK Query / Transaction Status). It never re-sends.
4. **Persist before acknowledging.** Callbacks are stored first, then transitioned,
   then queued for the tenant webhook, and only then acked. If any step fails, return 500.
5. **Tenant isolation.** Every tenant read filters by `businessId` + `environment`.
   A foreign transaction id returns 404, never 403.
6. **No secrets in plaintext.** API keys are stored as HMAC hashes. Daraja credentials and
   webhook secrets are AES-256-GCM encrypted, bound to `businessId:environment`. Secrets are
   shown once at creation.
7. **No PII or secrets in logs.** Log ids, codes, and statuses only.
8. **KISS.** Prefer one clear path over configurability. Add a product only when it has a
   caller.

---

## Architecture snapshot (2026-11-17)

```
Tenant ──HTTPS──▶ api.rotsi.co.ke (Worker, Hono)
                    ├─ /v1/*            tenant API (API key, scopes, rate limit, idempotency)
                    ├─ /v1/admin/*      operator API (admin token; add Cloudflare Access)
                    └─ /v1/hooks/*      Safaricom callbacks (HMAC-signed URLs)
                          │
                          ├──RPC──▶ MongoDBConnection DO ×N shards ──▶ MongoDB Atlas
                          ├──fetch─▶ Daraja (sandbox.safaricom.co.ke | api.safaricom.co.ke)
                          └──send──▶ Queue rotsi-webhooks ──▶ tenant webhook (signed, backoff, DLQ)
Cron */5 ─▶ reconcile PROCESSING/UNKNOWN + re-queue lost webhooks
```

- **Sandbox and live in one deployment.** The API key prefix picks the environment:
  `rk_test_…` uses the Daraja sandbox, `rk_live_…` uses production. `LIVE_PAYMENTS_ENABLED`
  is the global kill switch for live money movement.
- **One M-Pesa account per business per environment** (`payments_daraja_accounts`).
  Live shortcodes are unique across tenants. The shared sandbox test shortcodes are not.
- **Callback auth.** Safaricom doesn't sign callbacks, so we sign the URL:
  `/v1/hooks/{kind}/{ref}/{hmac}`. The HMAC is hex because Daraja rejects URLs containing
  words like `exe`, `cmd`, or `sql`. An optional IP allowlist is set by `DARAJA_CALLBACK_IPS`.
- **Keys.** A single `MASTER_KEY` secret, from which HKDF derives the credential
  encryption key, the API-key pepper, and the callback-signing key.
- **DB access.** The mongodb driver runs inside a Durable Object so pooled connections are
  reused across requests. Requests are spread over `MONGODB_SHARDS` objects at random.
  Raise the shard count as load grows; evaluate Hyperdrive-style pooling if MongoDB gains
  support.

### Code map

| Path | What it does |
| --- | --- |
| `src/index.ts` | fetch + queue + scheduled handlers, DO export |
| `src/app.ts` | middleware (secure headers, body limit, no-store), routing, error mapping |
| `src/routes/tenant.ts` | `/v1` tenant endpoints + Zod schemas |
| `src/routes/admin.ts` | onboarding: businesses, keys, webhooks, M-Pesa config, C2B register, review queue |
| `src/routes/hooks.ts` | Safaricom callback entrypoint (signature, IP allowlist, dispatch) |
| `src/routes/middleware.ts` | tenant auth, scopes, idempotency header, admin auth, rate limiting |
| `src/services/payments.ts` | STK, B2C, B2B, C2B register/simulate; the initiate→settle flow |
| `src/services/callbacks.ts` | callback parsing and state transitions |
| `src/services/reconcile.ts` | cron reconciliation via STK Query / Transaction Status |
| `src/services/webhooks.ts` | queue consumer, signing, backoff, sweeper |
| `src/services/events.ts` | public transaction view, webhook emission, payout-limit release |
| `src/daraja/client.ts` | Daraja OAuth + product calls; ok / rejected / uncertain outcomes |
| `src/db/store.ts` | the only DB code: state machine, idempotency, indexes |
| `src/lib/crypto.ts` | HKDF keys, AES-GCM seal/unseal, HMAC helpers |

---

## M-Pesa product coverage

| Product | Status | Notes |
| --- | --- | --- |
| STK Push (Lipa na M-Pesa Online) | ✅ built | `POST /v1/stk-push`; STK Query used for reconciliation |
| C2B Register URL (v2) | ✅ built | admin-only; registers signed per-account URLs |
| C2B Validation / Confirmation | ✅ built | validation checks account status + limit |
| C2B Simulate | ✅ built | sandbox keys only |
| B2C (v3) | ✅ built | needs `payouts:write` scope + admin approval + daily limit |
| B2B (BusinessPayBill / BusinessBuyGoods) | ✅ built | same gates as B2C |
| Transaction Status | ✅ built (internal) | reconciliation of B2C/B2B |
| Account Balance | 🟡 proposed | see the case below |
| Reversal | 🟡 proposed | see the case below |
| Pull Transactions | 🟡 proposed | see the case below |
| Dynamic QR | 🟡 proposed | see the case below |
| M-Pesa Ratiba (standing orders), Bill Manager, B2Pochi, Tax Remittance | ⏸ later | only when a tenant asks |

### The case for the next APIs (in priority order)

1. **Pull Transactions API.** This is the strongest one. C2B callbacks are best-effort:
   if Safaricom never delivers a confirmation, the ledger silently misses money a
   customer *did* pay. Pull lets a cron backfill any shortcode's transactions for a time
   window and diff them against `payments_transactions`. That makes MongoDB a true final
   record rather than "whatever callbacks arrived". It needs a one-time Safaricom
   registration per shortcode.
2. **Account Balance.** Payout float checks. A B2C/B2B against an empty utility account
   fails on Safaricom's side after we have already accepted it. A cheap balance check
   (cached, async result) lets us refuse early and alert the tenant to top up. It is also
   a daily reconciliation number: opening + in − out should equal closing.
3. **Reversal.** Customers pay the wrong paybill constantly, and tenants will ask for this.
   It must be **admin-only with an approval record**, never a tenant self-serve call,
   because it pulls money back out of a customer wallet. It also reuses the existing
   result/timeout and UNKNOWN machinery.
4. **Dynamic QR.** It is nearly free to add, has no callbacks of its own (payments arrive as
   C2B/STK), and helps tenants with physical points of sale.

---

## Open items / next steps

- [ ] Put a **real Atlas URI** in `.dev.vars` (it still holds a placeholder) and set
      production secrets: `MONGODB_URI`, `MASTER_KEY`, `INTERNAL_ADMIN_TOKEN` (≥32 chars;
      the current local one is 26, so admin is disabled until it is rotated).
- [ ] Create the queues (`rotsi-webhooks`, `rotsi-webhooks-dlq`). Confirm `rotsi.co.ke` is a
      zone on the Cloudflare account, then deploy (`npm run deploy`).
- [ ] Put **Cloudflare Access** (service token) in front of `/v1/admin/*`.
- [ ] Verify Safaricom's current callback IP list and set `DARAJA_CALLBACK_IPS` in production.
- [ ] Daraja sandbox end-to-end run with real sandbox app credentials (STK to a test phone,
      C2B register + simulate, B2C to the test MSISDN).
- [ ] Confirm against Daraja docs: C2B register v2 vs v1 for your app, and whether
      `OriginalConversationID` is honoured by Transaction Status for B2C/B2B.
- [ ] Confirm whether STK payments to a paybill also hit the C2B confirmation URL. The
      code de-duplicates by receipt either way, and flags a collision for review.
- [ ] Automated tests in CI (vitest + `@cloudflare/vitest-pool-workers`). For now
      `scripts/smoke-test.py` is the end-to-end check.
- [ ] Before high volume: load-test the DO shards against Atlas and set
      `MONGODB_LOCATION_HINT` near the Atlas region.
- [ ] Per-transaction approvals for large B2B (above a threshold) before live payouts.

---

## Log

### 2026-11-17 — Payments engine: STK, C2B, B2C, B2B, callbacks, webhooks, reconciliation

**Changed**
- Replaced the Phase-1 repository layer with `src/db/store.ts`, a single DO data gateway.
  It holds an atomic transaction state machine (`REQUEST_RECEIVED → PROCESSING → SUCCESS |
  FAILED | UNKNOWN`) with an append-only `statusHistory`. Idempotency, receipt, and
  live-shortcode uniqueness are enforced by indexes. It also tracks daily payout counters
  and audit logs.
- Daraja client for OAuth, STK Push/Query, C2B register/simulate, B2C v3, B2B, and
  Transaction Status. Every call resolves to ok / rejected / uncertain.
- Multi-tenancy: businesses, scoped API keys (`payments:read`, `payments:write`,
  `payouts:write`), and environment taken from the key prefix. Per-tenant encrypted Daraja
  credentials and webhook secrets.
- Callbacks on signed URLs. Tenant webhooks go through Cloudflare Queues with HMAC
  signatures (`rotsi-signature: t=…,v1=…`), exponential backoff, and a DLQ. A cron
  reconciler and a webhook sweeper run every 5 minutes.
- Security: secure headers, a 32 KB body limit, `no-store`, Workers rate limiting, the
  live kill switch, a ≥32-char admin token, SSRF-safe webhook URLs (public https hostnames
  only, no redirects followed), and uniform 404s on bad callback signatures.
- `wrangler.jsonc`: added `nodejs_compat` (the mongodb driver needs it at runtime; it was
  missing), the queue, the rate limiter, cron, and the `api.rotsi.co.ke` custom domain.
  `workers_dev` is off.
- Replaced the per-env `DARAJA_CONSUMER_KEY/SECRET` with per-tenant credentials, and added
  `MASTER_KEY`.

**Verified**
- `npm run typecheck` and `npm run build` (wrangler dry-run) both clean.
- `scripts/smoke-test.py` against `wrangler dev` + a throwaway `mongo:7` container:
  **32/32 checks pass.** Covered:
  - Admin: auth, onboarding, and API keys returned once.
  - Storage: no plaintext secrets stored.
  - Request handling: validation, the idempotency header, replay, and key-reuse 409.
  - Gates: the live kill switch, the payout scope gate, and the payout approval gate.
  - Daraja: an auth failure lands as FAILED, not UNKNOWN.
  - Callbacks: a forged signature returns 404. A signed STK callback moves the transaction
    to SUCCESS with its receipt. A duplicate callback is a no-op. A late contradictory
    callback is flagged and the record is not overwritten. A duplicate receipt is flagged.
  - C2B: validation and confirmation work, and a confirmation is recorded exactly once.
  - Isolation: tenant B gets 404 on tenant A's transactions and an empty list.
  - Webhooks: delivered through the queue with a signature; a non-2xx is kept pending
    with backoff. The admin review queue lists flagged transactions.
- **Not verified:** real Daraja sandbox calls (no sandbox credentials configured yet),
  Atlas connectivity, deployment to `api.rotsi.co.ke`, and cron execution.

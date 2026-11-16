# Rotsi Payments API

Multi-tenant M-Pesa (Safaricom Daraja) payments infrastructure on Cloudflare Workers,
Hono, TypeScript and MongoDB Atlas. Businesses integrate with one API at
`https://api.rotsi.co.ke/v1` and never deal with Daraja directly.

> Engineering decisions, open items and the change log live in [`agent.md`](agent.md).

## What it does

| Product | Endpoint | Who |
| --- | --- | --- |
| STK Push | `POST /v1/stk-push` | tenant (`payments:write`) |
| B2C payout | `POST /v1/b2c/payments` | tenant (`payouts:write`, admin-approved) |
| B2B payment | `POST /v1/b2b/payments` | tenant (`payouts:write`, admin-approved) |
| C2B simulate | `POST /v1/c2b/simulate` | tenant, sandbox keys only |
| Transactions | `GET /v1/transactions`, `GET /v1/transactions/:id` | tenant (`payments:read`) |
| Profile | `GET /v1/businesses/me` | tenant |
| C2B URL registration | `POST /v1/admin/businesses/:id/mpesa/:env/c2b/register` | admin |
| Safaricom callbacks | `POST /v1/hooks/{kind}/{ref}/{signature}` | Safaricom only |

Transaction states are `REQUEST_RECEIVED`, `PROCESSING`, `SUCCESS`, `FAILED` and `UNKNOWN`.
A `202` with `PROCESSING` means Safaricom accepted the request. It does **not** mean money
has moved. The final state arrives by webhook (and is visible via `GET /v1/transactions/:id`).

## For integrators

```bash
curl https://api.rotsi.co.ke/v1/stk-push \
  -H "Authorization: Bearer $ROTSI_API_KEY" \
  -H "Idempotency-Key: order-10023" \
  -H "Content-Type: application/json" \
  -d '{"phone":"0712345678","amount":100,"accountReference":"ORDER10023","description":"Order"}'
```

- `rk_test_…` keys use the Daraja sandbox and `rk_live_…` keys use production. The base URL
  is the same for both.
- Every money-moving `POST` needs an `Idempotency-Key` (8–100 chars). Retrying with the same
  key returns the original transaction; reusing it with a different body returns `409`.
- Responses always look like `{ "success": true, "message": "...", "data": { ... } }`
  or `{ "success": false, "error": { "code": "...", "message": "..." } }`.

### Webhooks

Rotsi POSTs `transaction.success`, `transaction.failed` and `transaction.unknown` events
to your configured URL:

```
rotsi-event-id: evt_…          (dedupe on this — delivery is at-least-once)
rotsi-event-type: transaction.success
rotsi-signature: t=1763380000,v1=<hex>
```

Verify the event with `v1 == HMAC_SHA256(webhook_secret, "{t}.{raw_body}")`, and reject
it if `t` is more than 5 minutes old. Respond with any `2xx`. Failed deliveries are retried
with backoff (30 s up to 1 h, 10 attempts).

## Architecture

```
Tenant ─▶ Worker (Hono) ─┬─RPC─▶ MongoDBConnection Durable Objects (N shards) ─▶ Atlas
                          ├─────▶ Daraja sandbox / production
Safaricom ─▶ /v1/hooks ───┤
                          └─────▶ Queue ─▶ tenant webhooks (signed, retried, DLQ)
Cron (5 min) ─▶ reconcile PROCESSING/UNKNOWN, re-queue lost webhooks
```

- **Persist before acknowledging.** Each callback is stored, then its state transition is
  applied atomically, then the webhook is queued, and only then is Safaricom acked.
- **No automatic retries of money movement.** A timeout becomes `UNKNOWN`. The reconciler
  asks Safaricom (STK Query / Transaction Status) and never re-sends. Anything it cannot
  resolve lands in `GET /v1/admin/review`.
- **Final records are immutable.** A contradictory later outcome flags `needsReview`
  instead of overwriting the record.

### Collections (MongoDB)

`payments_businesses`, `payments_api_keys`, `payments_daraja_accounts`,
`payments_transactions`, `payments_payment_events` (raw Safaricom payloads),
`payments_webhook_deliveries`, `payments_payout_counters`, `payments_audit_logs`.
Indexes are created by `POST /v1/admin/database/initialize`.

## Security

- **API keys:** stored as HMAC-SHA256 hashes and shown once. Keys are scoped and tied to
  one environment.
- **Daraja credentials and webhook secrets:** AES-256-GCM encrypted, bound to the
  owning business and environment.
- **Keys:** one `MASTER_KEY` secret, from which HKDF derives every other key.
- **Callbacks:** URLs are HMAC-signed per transaction or account, and unknown or forged
  ones return 404. The Safaricom IP allowlist is optional
  (`DARAJA_CALLBACK_IPS`; verify Safaricom's current list before enabling).
- **Request handling:** Zod validation, a 32 KB body limit, secure headers, `no-store`, and
  per-key rate limiting.
- **Payouts:** need the `payouts:write` scope, admin approval (`payoutsEnabled`), a
  per-transaction limit, and an atomic daily limit.
- **Live kill switch:** `LIVE_PAYMENTS_ENABLED` must be `"true"` for any live money
  movement.
- **Admin API:** a ≥32-char bearer token. In production, also put Cloudflare Access in
  front of `/v1/admin/*`.

## Setup

Requirements: Node.js 20+, a Cloudflare account on the Workers Paid plan (Queues),
and a MongoDB Atlas cluster.

```bash
npm install
npx wrangler types
npm run typecheck
npm run build
```

### Local development

Create `.dev.vars` (never commit it); see `.dev.vars.example`:

```
MONGODB_URI=mongodb+srv://...
MONGODB_DATABASE=rotsi_payments_dev
MASTER_KEY=<openssl rand -base64 32>
INTERNAL_ADMIN_TOKEN=<openssl rand -hex 32>
PUBLIC_BASE_URL=https://<your-tunnel>   # Safaricom must reach your callbacks
```

```bash
npm run dev
```

### Local smoke test

This test runs against a throwaway local MongoDB and never touches Atlas:

```bash
docker run -d --rm --name rotsi-mongo-test -p 127.0.0.1:27018:27017 mongo:7
```

```bash
export ROTSI_ADMIN_TOKEN=$(openssl rand -hex 24)
npx wrangler dev --port 8799 --var "INTERNAL_ADMIN_TOKEN:$ROTSI_ADMIN_TOKEN" \
  --var MONGODB_URI:mongodb://127.0.0.1:27018 --var MONGODB_DATABASE:rotsi_payments_dev
```

In another shell, with the same `ROTSI_ADMIN_TOKEN` exported:

```bash
python3 -I scripts/smoke-test.py
```

```bash
docker stop rotsi-mongo-test
```

### Deploy to api.rotsi.co.ke

`rotsi.co.ke` must be a zone on the same Cloudflare account. Create the queues:

```bash
npx wrangler queues create rotsi-webhooks
```

```bash
npx wrangler queues create rotsi-webhooks-dlq
```

Set the three secrets, one at a time:

```bash
npx wrangler secret put MONGODB_URI
```

```bash
npx wrangler secret put MASTER_KEY
```

```bash
npx wrangler secret put INTERNAL_ADMIN_TOKEN
```

Then deploy:

```bash
npm run deploy
```

After deploying, initialize the indexes once:

```bash
read -s INTERNAL_ADMIN_TOKEN && export INTERNAL_ADMIN_TOKEN
curl -X POST https://api.rotsi.co.ke/v1/admin/database/initialize \
  -H "Authorization: Bearer ${INTERNAL_ADMIN_TOKEN}"
```

### Onboarding a business (admin)

1. `POST /v1/admin/businesses` with `{ "name", "slug" }`.
2. `PUT /v1/admin/businesses/:id/mpesa/sandbox` with `{ shortcode, shortcodeType,
   consumerKey, consumerSecret, passkey?, initiatorName?, securityCredential?, limits? }`.
   `securityCredential` is the initiator password already encrypted with Safaricom's
   certificate; generate it on the Daraja portal.
3. `POST /v1/admin/businesses/:id/mpesa/sandbox/c2b/register`.
4. `PUT /v1/admin/businesses/:id/webhooks/sandbox` with `{ url }`. The secret is
   returned once.
5. `POST /v1/admin/businesses/:id/api-keys` with `{ environment, scopes }`. The key is
   returned once.
6. For payouts: `PATCH /v1/admin/businesses/:id/mpesa/:env` with `{ "payoutsEnabled": true }`.

Repeat with `production` after Safaricom go-live approval. Keep `LIVE_PAYMENTS_ENABLED`
at `"false"` until then.

# Rotsi Payments API

A multi-tenant M-Pesa payments API built on Cloudflare Workers, Hono, TypeScript, and MongoDB Atlas.

## Current status

The Worker foundation and MongoDB data layer are being established. Initial development targets the Safaricom Daraja sandbox. Production credentials must be configured only as Cloudflare secrets and must never be committed to this repository.

## Architecture

- Cloudflare Worker + Hono handles HTTP routing.
- A Durable Object owns the MongoDB client and executes database operations.
- MongoDB Atlas stores tenant, API-key, transaction, callback-event, webhook-delivery, and audit records.
- MongoDB objects are never returned across the Durable Object RPC boundary.
- The current database connection manager is a single low-volume instance. It must be load-tested and partitioned before relying on it for high throughput.

Cloudflare's MongoDB integration guidance: https://developers.cloudflare.com/workers/databases/third-party-integrations/mongodb/

## Database collections

| Collection | Purpose |
| --- | --- |
| businesses | Tenant/business records |
| api_keys | Hashed API credentials, scopes, and status |
| transactions | Tenant-scoped C2B/B2B transaction state |
| payment_events | Deduplicated provider callback events |
| webhook_deliveries | Outbound tenant webhook attempts |
| audit_logs | Security and business activity trail |

Indexes are created explicitly by the initialization endpoint. Run initialization once for each new environment before enabling application traffic.

## Local development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run types
npm run typecheck
npm run dev
```

Create a local `.dev.vars` file for secrets. Never commit it.

Required local secrets:

- `MONGODB_URI`
- `INTERNAL_ADMIN_TOKEN`
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`

The sandbox database name is configured as `rotsi_payments_sandbox` in `wrangler.jsonc`.

## Database initialization

Configure secrets in the local environment or Cloudflare:

```bash
npx wrangler secret put MONGODB_URI
npx wrangler secret put INTERNAL_ADMIN_TOKEN
```

After starting or deploying the Worker, initialize indexes using the protected endpoint:

```bash
curl -X POST http://localhost:8787/internal/database/initialize \
  -H "Authorization: Bearer YOUR_SETUP_TOKEN"
```

Verify database readiness:

```bash
curl http://localhost:8787/health/ready
```

Do not put the setup token in a URL, source file, shell history, or Git commit. Prefer an environment variable when invoking curl.

## Environments

Sandbox and production configuration must remain separate. Never use live credentials for local development or sandbox tests. Production deployment requires a separate database, secrets, configuration, and operational review.

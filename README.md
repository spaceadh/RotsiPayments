# Rotsi Payments API

A multi-tenant M-Pesa payments API built on Cloudflare Workers, Hono, TypeScript, and MongoDB Atlas.

## Current status

Project foundation is being established. Initial development targets the Safaricom Daraja sandbox. Production credentials must be configured only as Cloudflare secrets and must never be committed to this repository.

## Planned capabilities

- Tenant-scoped API authentication
- M-Pesa C2B callbacks and registration
- M-Pesa B2B payment initiation and result callbacks
- Transaction records, idempotency, audit events, and reconciliation
- Tenant webhook delivery

## Local development

Requirements: Node.js LTS and npm.

```bash
npm install
npm run dev
```

Create a local `.dev.vars` file for non-production secrets when the relevant integrations are implemented. Do not commit it.

## Environments

Sandbox and production configuration must remain separate. Never use live credentials for local development or sandbox tests.

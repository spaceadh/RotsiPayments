import { DarajaClient } from "../daraja/client";
import { getStore } from "../db/client";
import type { DarajaAccount, DarajaCredentials } from "../db/models";
import type { Env, Environment } from "../env";
import { seal, unseal } from "../lib/crypto";

export type LoadedAccount = {
  account: DarajaAccount;
  credentials: DarajaCredentials;
  client: DarajaClient;
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; value: LoadedAccount | null }>();

/** Encryption context: ties a ciphertext to exactly one tenant + environment. */
export function credentialsContext(businessId: string, environment: Environment): string {
  return `daraja:${businessId}:${environment}`;
}

export function webhookSecretContext(businessId: string, environment: Environment): string {
  return `webhook:${businessId}:${environment}`;
}

export function sealCredentials(env: Env, businessId: string, environment: Environment, credentials: DarajaCredentials) {
  return seal(env, JSON.stringify(credentials), credentialsContext(businessId, environment));
}

async function hydrate(env: Env, account: DarajaAccount): Promise<LoadedAccount> {
  const credentials = JSON.parse(
    await unseal(env, account.credentials, credentialsContext(account.businessId, account.environment)),
  ) as DarajaCredentials;
  return { account, credentials, client: new DarajaClient(account.environment, account._id, credentials) };
}

/** The tenant's M-Pesa account for an environment, decrypted. Cached briefly per isolate. */
export async function loadAccount(env: Env, businessId: string, environment: Environment): Promise<LoadedAccount | null> {
  const key = `${businessId}:${environment}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const account = await getStore(env).findDarajaAccount(businessId, environment);
  const value = account ? await hydrate(env, account) : null;
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function loadAccountById(env: Env, accountId: string): Promise<LoadedAccount | null> {
  const account = await getStore(env).getDarajaAccount(accountId);
  return account ? hydrate(env, account) : null;
}

export function forgetAccount(businessId: string, environment: Environment): void {
  cache.delete(`${businessId}:${environment}`);
}

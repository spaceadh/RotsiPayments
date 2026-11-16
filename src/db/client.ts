import type { Env } from "../env";

/**
 * Get a database stub. Load is spread across MONGODB_SHARDS identical
 * connection-owning Durable Objects (each with its own small pool), so one
 * object never becomes the bottleneck. Raise the number as traffic grows.
 */
export function getStore(env: Env) {
  const shards = Math.min(Math.max(Number(env.MONGODB_SHARDS) || 1, 1), 64);
  const shard = Math.floor(Math.random() * shards);
  const id = env.MONGODB_CONNECTION.idFromName(`mongodb-${shard}`);
  const hint = env.MONGODB_LOCATION_HINT as DurableObjectLocationHint | undefined;
  return env.MONGODB_CONNECTION.get(id, hint ? { locationHint: hint } : undefined);
}

export type Store = ReturnType<typeof getStore>;

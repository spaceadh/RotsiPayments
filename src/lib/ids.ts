const PREFIXES = {
  transaction: "txn_",
  business: "biz_",
  account: "acc_",
  apiKey: "key_",
  event: "evt_",
} as const;

export type IdKind = keyof typeof PREFIXES;

const OBJECT_ID = /^[a-f0-9]{24}$/;

export function toPublicId(kind: IdKind, id: string): string {
  return `${PREFIXES[kind]}${id}`;
}

/** Returns the internal ObjectId hex, or null for anything malformed. */
export function fromPublicId(kind: IdKind, value: string): string | null {
  const prefix = PREFIXES[kind];
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return OBJECT_ID.test(id) ? id : null;
}

export function isObjectIdHex(value: string): boolean {
  return OBJECT_ID.test(value);
}

/** 24-hex id generated in the Worker (valid as a MongoDB ObjectId). */
export function newId(): string {
  const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const random = crypto.getRandomValues(new Uint8Array(8));
  return seconds + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

import type { Env } from "../env";
import { AppError } from "./http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Sealed = { v: 1; iv: string; ct: string };

// ---------- encoding ----------

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

// ---------- keys derived from MASTER_KEY ----------

type DerivedKeys = {
  credentials: CryptoKey; // AES-256-GCM for Daraja credentials and webhook secrets
  apiKeys: CryptoKey; // HMAC pepper for API key hashes
  callbacks: CryptoKey; // HMAC for signed Safaricom callback URLs
};

let cachedFor: string | null = null;
let cachedKeys: Promise<DerivedKeys> | null = null;

async function deriveKeys(masterKey: string): Promise<DerivedKeys> {
  const raw = fromBase64(masterKey);
  if (raw.length < 32) throw new Error("MASTER_KEY must be at least 32 bytes.");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const params = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("rotsi-payments"),
    info: encoder.encode(info),
  });
  const hmac = { name: "HMAC", hash: "SHA-256", length: 256 };
  const [credentials, apiKeys, callbacks] = await Promise.all([
    crypto.subtle.deriveKey(params("credentials/v1"), base, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.deriveKey(params("api-keys/v1"), base, hmac, false, ["sign"]),
    crypto.subtle.deriveKey(params("callbacks/v1"), base, hmac, false, ["sign"]),
  ]);
  return { credentials, apiKeys, callbacks };
}

function keys(env: Env): Promise<DerivedKeys> {
  const master = env.MASTER_KEY;
  if (!master) {
    throw new AppError(503, "NOT_CONFIGURED", "The service is not fully configured.");
  }
  if (cachedFor !== master || !cachedKeys) {
    cachedFor = master;
    cachedKeys = deriveKeys(master).catch((error: unknown) => {
      cachedKeys = null;
      throw error;
    });
  }
  return cachedKeys;
}

async function hmacHex(key: CryptoKey, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

// ---------- public helpers ----------

/**
 * Encrypt with AES-256-GCM. `context` is bound as additional data so a
 * ciphertext copied onto another tenant's record will not decrypt.
 */
export async function seal(env: Env, plaintext: string, context: string): Promise<Sealed> {
  const { credentials } = await keys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    credentials,
    encoder.encode(plaintext),
  );
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export async function unseal(env: Env, sealed: Sealed, context: string): Promise<string> {
  const { credentials } = await keys(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(context) },
    credentials,
    fromBase64(sealed.ct),
  );
  return decoder.decode(plaintext);
}

export async function hashApiKey(env: Env, apiKey: string): Promise<string> {
  return hmacHex((await keys(env)).apiKeys, apiKey);
}

/** Hex only: Safaricom rejects callback URLs containing words like "exe", "cmd" or "sql". */
export async function callbackSignature(env: Env, kind: string, ref: string): Promise<string> {
  return (await hmacHex((await keys(env)).callbacks, `${kind}:${ref}`)).slice(0, 32);
}

/** Signature tenants verify on our webhooks: HMAC-SHA256(secret, `${t}.${body}`). */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hmacHex(key, `${timestamp}.${body}`);
}

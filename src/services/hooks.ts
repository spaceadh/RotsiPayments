import type { Env } from "../env";
import { callbackSignature, constantTimeEqual } from "../lib/crypto";

/**
 * Safaricom does not sign callbacks, so we sign the URL instead:
 *   /v1/hooks/{kind}/{ref}/{hmac(kind:ref)}
 * `ref` is our transaction id (or account id for C2B). A forged callback
 * would need the HMAC, and a valid one can only ever touch its own record.
 */
export const HOOK_KINDS = [
  "stk",
  "result",
  "timeout",
  "status",
  "status-timeout",
  "c2b-validation",
  "c2b-confirmation",
] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

export async function hookUrl(env: Env, kind: HookKind, ref: string): Promise<string> {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${base}/v1/hooks/${kind}/${ref}/${await callbackSignature(env, kind, ref)}`;
}

export async function verifyHook(env: Env, kind: string, ref: string, signature: string): Promise<boolean> {
  return constantTimeEqual(signature, await callbackSignature(env, kind, ref));
}

export function callbackIpAllowed(env: Env, ip: string | undefined): boolean {
  const allowlist = (env.DARAJA_CALLBACK_IPS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.length === 0 || (ip !== undefined && allowlist.includes(ip));
}

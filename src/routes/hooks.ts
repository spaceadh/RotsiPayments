import { Hono } from "hono";
import { isObjectIdHex } from "../lib/ids";
import { errorInfo, log } from "../lib/log";
import {
  handleC2BConfirmation,
  handleC2BValidation,
  handleResultCallback,
  handleStatusCallback,
  handleStkCallback,
  handleTimeoutCallback,
} from "../services/callbacks";
import { callbackIpAllowed, HOOK_KINDS, verifyHook, type HookKind } from "../services/hooks";
import type { AppEnv } from "./middleware";

/** Inbound Safaricom callbacks. Not for tenants; URLs are signed (see services/hooks.ts). */
export const hookRoutes = new Hono<AppEnv>();

const ACCEPTED = { ResultCode: 0, ResultDesc: "Accepted" };

hookRoutes.post("/:kind/:ref/:sig", async (c) => {
  const { kind, ref, sig } = c.req.param();
  const ip = c.req.header("cf-connecting-ip");

  // Uniform 404 for anything unauthenticated: reveal nothing about what exists.
  const notFound = () => c.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  if (!HOOK_KINDS.includes(kind as HookKind) || !isObjectIdHex(ref)) return notFound();
  if (!(await verifyHook(c.env, kind, ref, sig))) {
    log("warn", "hook.bad_signature", { kind, ip });
    return notFound();
  }
  if (!callbackIpAllowed(c.env, ip)) {
    log("warn", "hook.ip_blocked", { kind, ip });
    return notFound();
  }

  const payload: unknown = await c.req.json().catch(() => ({ unparseable: true }));

  try {
    switch (kind as HookKind) {
      case "stk":
        await handleStkCallback(c.env, ref, payload);
        break;
      case "result":
        await handleResultCallback(c.env, ref, payload);
        break;
      case "timeout":
        await handleTimeoutCallback(c.env, ref, payload);
        break;
      case "status":
        await handleStatusCallback(c.env, ref, payload);
        break;
      case "status-timeout":
        break; // the next reconciliation round will ask again
      case "c2b-validation":
        return c.json(await handleC2BValidation(c.env, ref, payload));
      case "c2b-confirmation":
        await handleC2BConfirmation(c.env, ref, payload);
        break;
    }
  } catch (error) {
    // Not persisted means not acknowledged: let Safaricom retry where it does.
    log("error", "hook.processing_failed", { kind, ref, ...errorInfo(error) });
    return c.json({ ResultCode: 1, ResultDesc: "Temporary failure" }, 500);
  }
  return c.json(ACCEPTED);
});

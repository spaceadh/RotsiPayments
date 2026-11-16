import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { getStore } from "./db/client";
import { AppError, errorBody } from "./lib/http";
import { errorInfo, log } from "./lib/log";
import { adminRoutes } from "./routes/admin";
import { hookRoutes } from "./routes/hooks";
import type { AppEnv } from "./routes/middleware";
import { tenantRoutes } from "./routes/tenant";

const app = new Hono<AppEnv>();

// Server-to-server JSON API: no CORS, no cookies, small bodies, strict headers.
app.use("*", requestId());
app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
app.use(
  "*",
  bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "The request body is too large."), 413),
  }),
);
app.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "no-store");
});

app.get("/", (c) => c.json({ success: true, service: "Rotsi Payments API", version: "v1" }));
app.get("/health", (c) => c.json({ success: true, status: "ok" }));
app.get("/health/ready", async (c) => {
  try {
    const db = await getStore(c.env).ping();
    return c.json({ success: true, status: "ready", dependencies: { mongodb: db } });
  } catch {
    return c.json({ success: false, status: "not_ready", dependencies: { mongodb: "unavailable" } }, 503);
  }
});

// Order matters: hooks and admin are mounted before the tenant catch-all auth.
app.route("/v1/hooks", hookRoutes);
app.route("/v1/admin", adminRoutes);
app.route("/v1", tenantRoutes);

app.notFound((c) => c.json(errorBody("NOT_FOUND", "The requested resource was not found."), 404));

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json(errorBody(error.code, error.message, error.details), error.status);
  }
  // Never echo internals, request bodies, credentials or payment data.
  log("error", "api.unhandled_error", { path: c.req.path, requestId: c.get("requestId"), ...errorInfo(error) });
  return c.json(errorBody("INTERNAL_SERVER_ERROR", "An unexpected error occurred."), 500);
});

export default app;

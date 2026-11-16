import { Hono } from "hono";
import type { Env } from "./env";
import { constantTimeEqual } from "./security/timing-safe";

const app = new Hono<{ Bindings: Env }>();

function getDatabaseStub(env: Env) {
  const id = env.MONGODB_CONNECTION.idFromName("mongodb-primary");
  return env.MONGODB_CONNECTION.get(id);
}

app.get("/", (c) =>
  c.json({
    success: true,
    service: "Rotsi Payments API",
    version: "v1",
  }),
);

// Liveness: confirms that the Worker process can serve requests.
app.get("/health", (c) =>
  c.json({
    success: true,
    status: "ok",
  }),
);

app.get("/health/live", (c) =>
  c.json({
    success: true,
    status: "alive",
  }),
);

// Readiness: verifies that MongoDB can be reached.
app.get("/health/ready", async (c) => {
  try {
    const database = await getDatabaseStub(c.env).ping();
    return c.json({
      success: true,
      status: "ready",
      dependencies: {
        mongodb: {
          status: database.status,
          latencyMs: database.latencyMs,
        },
      },
    });
  } catch {
    // Do not expose database hostnames, connection strings, or driver errors.
    return c.json(
      {
        success: false,
        status: "not_ready",
        dependencies: {
          mongodb: "unavailable",
        },
      },
      503,
    );
  }
});

// Explicit schema bootstrap. This endpoint is disabled until the setup
// token is configured as a Cloudflare secret.
app.post("/internal/database/initialize", async (c) => {
  const expectedToken = c.env.INTERNAL_ADMIN_TOKEN;
  if (!expectedToken) {
    return c.json(
      {
        success: false,
        error: {
          code: "SETUP_NOT_CONFIGURED",
          message: "Database initialization is not enabled.",
        },
      },
      503,
    );
  }

  const authorization = c.req.header("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  if (!constantTimeEqual(suppliedToken, expectedToken)) {
    return c.json(
      {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "A valid authorization token is required.",
        },
      },
      401,
    );
  }

  try {
    const result = await getDatabaseStub(c.env).initialize();
    return c.json({
      success: true,
      data: result,
    });
  } catch {
    return c.json(
      {
        success: false,
        error: {
          code: "DATABASE_INITIALIZATION_FAILED",
          message: "Database initialization failed.",
        },
      },
      503,
    );
  }
});

app.get("/v1", (c) =>
  c.json({
    success: true,
    apiVersion: "v1",
    status: "foundation",
  }),
);

app.notFound((c) =>
  c.json(
    {
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    },
    404,
  ),
);

app.onError((error, c) => {
  // Do not log request bodies, credentials, or payment data.
  console.error("Unhandled API error", {
    name: error.name,
    message: error.message,
    path: c.req.path,
  });

  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    },
    500,
  );
});

export default app;

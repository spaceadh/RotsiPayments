import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    success: true,
    service: "Rotsi Payments API",
    version: "v1",
  }),
);

app.get("/health", (c) =>
  c.json({
    success: true,
    status: "ok",
  }),
);

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

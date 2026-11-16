import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** An error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorBody(code: string, message: string, details?: unknown) {
  return {
    success: false as const,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

export function ok<T>(data: T, message?: string) {
  return message ? { success: true as const, message, data } : { success: true as const, data };
}

/** Validate input with Zod. Echoes field paths only, never submitted values. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "The request is invalid.",
      result.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(body)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
}

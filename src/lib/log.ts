type Level = "info" | "warn" | "error";

/**
 * Structured logs for Workers Observability.
 * Never pass request bodies, credentials, tokens or full phone numbers.
 */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  console[level]({ event, ...fields });
}

export function errorInfo(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Unknown", message: String(error) };
}

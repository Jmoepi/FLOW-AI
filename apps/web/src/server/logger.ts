import { safeStringify } from "@flow-ai/contracts";
export type LogLevel = "info" | "warn" | "error";
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
/**
 * One structured JSON line per event. Every line goes through safeStringify, so a seed, token, password or
 * connection string that slips into a field is redacted (AL-1). Callers pass `redactError(err)` strings, not Error objects.
 */
export function createLogger(sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    sink(safeStringify({ ts: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

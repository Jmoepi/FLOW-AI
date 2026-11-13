import { redactError } from "@flow-ai/contracts";
import { DbError } from "@flow-ai/database";
import { ZodError } from "zod";
import type { Logger } from "../logger";
/** A deliberate, user-safe failure. Message and code are fixed strings written by us, never copied from input or the database. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, options: { headers?: Record<string, string>; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = options.headers ?? {};
    this.extra = options.extra ?? {};
  }
}
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
export function jsonResponse(status: number, body: unknown, headers: Record<string, string | string[]> = {}): Response {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const item of v) h.append(k, item);
    else h.set(k, v);
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
}
/** Field paths only: never the offending values (they may hold secrets or hostile text). */
export function validationBody(err: ZodError, requestId: string): Record<string, unknown> {
  const fields = [...new Set(err.issues.map((i) => i.path.map(String).join(".") || "(body)"))].slice(0, 20);
  return { code: "VALIDATION_FAILED", message: "The request was not valid.", fields, request_id: requestId };
}
/** Maps anything thrown by a handler to a stable, non-leaking response. Unknown errors are logged redacted, answered 500. */
export function errorResponse(err: unknown, requestId: string, logger: Logger, extraHeaders: Record<string, string> = {}): Response {
  if (err instanceof HttpError) {
    return jsonResponse(err.status, { code: err.code, message: err.message, ...err.extra, request_id: requestId }, { ...extraHeaders, ...err.headers });
  }
  if (err instanceof ZodError) return jsonResponse(400, validationBody(err, requestId), extraHeaders);
  if (err instanceof DbError) {
    if (err.code === "NOT_FOUND") return jsonResponse(404, { code: "NOT_FOUND", message: "Not found.", request_id: requestId }, extraHeaders);
    if (err.code === "INVALID_ID" || err.code === "INVALID_INPUT" || err.code === "CHECK_VIOLATION") {
      logger.warn("request.rejected_by_database", { request_id: requestId, db_code: err.code });
      return jsonResponse(400, { code: "VALIDATION_FAILED", message: "The request was not valid.", request_id: requestId }, extraHeaders);
    }
    logger.error("request.db_error", { request_id: requestId, db_code: err.code });
    return jsonResponse(500, { code: "INTERNAL", message: "Something went wrong.", request_id: requestId }, extraHeaders);
  }
  logger.error("request.unhandled", { request_id: requestId, message: redactError(err) });
  return jsonResponse(500, { code: "INTERNAL", message: "Something went wrong.", request_id: requestId }, extraHeaders);
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { redactError } from "@flow-ai/contracts";
import type { Logger } from "../logger";
/** Stable, generic error bodies (IN-7): never a stack, SQL, path or the offending value. */
export const ERROR_BODIES = {
  400: { error: "INVALID_REQUEST" },
  401: { error: "unauthorized" },
  404: { error: "not_found" },
  409: { error: "IDEMPOTENCY_KEY_REUSED" },
  413: { error: "payload_too_large" },
  415: { error: "unsupported_media_type" },
  429: { error: "rate_limited" },
  500: { error: "internal_error" },
} as const;
export type ErrorStatus = keyof typeof ERROR_BODIES;
/** Thrown by route code for an expected client error. */
export class HttpError extends Error {
  readonly status: ErrorStatus;
  constructor(status: ErrorStatus) {
    super(ERROR_BODIES[status].error);
    this.name = "HttpError";
    this.status = status;
  }
}
export function sendError(reply: FastifyReply, status: ErrorStatus): FastifyReply {
  return reply.code(status).type("application/json; charset=utf-8").send(ERROR_BODIES[status]);
}
function statusOf(err: unknown): ErrorStatus {
  if (err instanceof HttpError) return err.status;
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof code === "number" && code in ERROR_BODIES && code !== 500) return code as ErrorStatus;
  if (typeof code === "number" && code >= 400 && code < 500) return 400;
  return 500;
}
export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const status = statusOf(err);
    if (status === 500) logger.error("request.failed", { request_id: req.id, error: redactError(err) });
    return sendError(reply, status);
  };
}
export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendError(reply, 404);
}

import type { ZodType } from "zod";
import { csrfTokenValid, isSafeMethod, originAllowed } from "../auth/csrf";
import { clientIp } from "../auth/rate-limit";
import type { SessionContext } from "../auth/provider";
import { getSessionContext } from "../auth/session";
import type { WebDeps } from "../deps";
import { HttpError, SECURITY_HEADERS, errorResponse, validationBody } from "./errors";
import { newRequestId } from "./request-id";
/**
 * Deny-by-default route kit (AZ-1). A route cannot be constructed without declaring who may call it. The wrapper order is
 * fixed: request id -> declared-size and media-type checks -> session (401) -> role (403) -> CSRF (403) -> strict body,
 * query and params parsing (400) -> handler -> error mapping. The business id always comes from the session.
 */
export type RouteRole = "owner" | "member" | "public";
export type CsrfMode = "none" | "origin" | "token";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const MAX_BODY_BYTES = 100 * 1024;
const ROLES: readonly RouteRole[] = ["owner", "member", "public"];
const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export interface HandlerContext<R extends RouteRole, B, Q, P> {
  deps: WebDeps;
  request: Request;
  requestId: string;
  /** Null only on public routes. */
  session: R extends "public" ? null : SessionContext;
  body: B;
  query: Q;
  params: P;
  ip: string;
}
export interface RouteDef<R extends RouteRole, B, Q, P> {
  method: HttpMethod;
  /** Public path pattern, e.g. /api/suppliers/:id (also the registry key for the route-table test). */
  path: string;
  role: R;
  csrf?: CsrfMode;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  handler: (ctx: HandlerContext<R, B, Q, P>) => Promise<Response>;
}
export interface Route {
  method: HttpMethod;
  path: string;
  role: RouteRole;
  csrf: CsrfMode;
  run: (deps: WebDeps, request: Request, rawParams?: Record<string, string | string[] | undefined>) => Promise<Response>;
}
export function defineRoute<R extends RouteRole, B = undefined, Q = undefined, P = undefined>(def: RouteDef<R, B, Q, P>): Route {
  if (!ROLES.includes(def.role)) throw new Error(`route ${def.method} ${def.path}: a role must be declared (deny by default)`);
  if (!METHODS.includes(def.method)) throw new Error(`route ${def.path}: unsupported method`);
  if (!def.path.startsWith("/api/")) throw new Error(`route ${def.path}: must live under /api/`);
  const safe = isSafeMethod(def.method);
  const csrf: CsrfMode = def.csrf ?? (safe ? "none" : def.role === "public" ? "origin" : "token");
  if (!safe && csrf === "none") throw new Error(`route ${def.method} ${def.path}: state-changing routes must use CSRF protection`);
  if (!safe && def.role !== "public" && csrf !== "token") throw new Error(`route ${def.method} ${def.path}: authenticated writes need the CSRF token`);
  if (def.body && safe) throw new Error(`route ${def.method} ${def.path}: a safe method cannot take a body`);
  const run: Route["run"] = async (deps, request, rawParams = {}) => {
    const requestId = newRequestId();
    try {
      const response = await pipeline(def, csrf, deps, request, requestId, rawParams);
      return finish(response, requestId);
    } catch (err) {
      return finish(errorResponse(err, requestId, deps.logger), requestId);
    }
  };
  return { method: def.method, path: def.path, role: def.role, csrf, run };
}
function finish(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function pipeline<R extends RouteRole, B, Q, P>(
  def: RouteDef<R, B, Q, P>,
  csrf: CsrfMode,
  deps: WebDeps,
  request: Request,
  requestId: string,
  rawParams: Record<string, string | string[] | undefined>,
): Promise<Response> {
  if (request.method.toUpperCase() !== def.method) throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { headers: { allow: def.method } });
  const hasBody = def.body !== undefined;
  if (hasBody) {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  let session: SessionContext | null = null;
  if (def.role !== "public") {
    session = await getSessionContext(deps, request);
    if (session === null) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (def.role === "owner" && session.role !== "owner") throw new HttpError(403, "FORBIDDEN", "You do not have permission to do this.");
  }
  if (csrf !== "none") {
    if (!originAllowed(request, deps.config.appOrigin)) throw new HttpError(403, "CSRF_FAILED", "The request origin was not accepted.");
    if (csrf === "token" && (session === null || !csrfTokenValid(request, session.csrfHash))) throw new HttpError(403, "CSRF_FAILED", "The request origin was not accepted.");
  }
  let body: unknown;
  if (def.body) {
    const text = await readCapped(request);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return validationResponse(requestId);
    }
    const parsed = def.body.safeParse(json);
    if (!parsed.success) return new Response(JSON.stringify(validationBody(parsed.error, requestId)), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
    body = parsed.data;
  }
  const query = parseQuery(def, request, requestId);
  if (query instanceof Response) return query;
  let params: unknown;
  if (def.params) {
    const parsed = def.params.safeParse(rawParams);
    if (!parsed.success) return new Response(JSON.stringify(validationBody(parsed.error, requestId)), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
    params = parsed.data;
  }
  const ctx = {
    deps,
    request,
    requestId,
    session,
    body: body as B,
    query: query.value as Q,
    params: params as P,
    ip: clientIp(request, deps.config.trustProxy),
  } as HandlerContext<R, B, Q, P>;
  return def.handler(ctx);
}
function validationResponse(requestId: string): Response {
  return new Response(JSON.stringify({ code: "VALIDATION_FAILED", message: "The request was not valid.", fields: ["(body)"], request_id: requestId }), {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function parseQuery<R extends RouteRole, B, Q, P>(def: RouteDef<R, B, Q, P>, request: Request, requestId: string): { value: unknown } | Response {
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (!def.query) {
    // A route that declares no query accepts none: unknown input is rejected, not ignored.
    return keys.length === 0 ? { value: undefined } : validationResponse(requestId);
  }
  if (new Set(keys).size !== keys.length) return validationResponse(requestId);
  const parsed = def.query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return new Response(JSON.stringify(validationBody(parsed.error, requestId)), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
  return { value: parsed.data };
}
/** Reads the body with a hard byte cap (the declared length can lie or be absent with chunked encoding). */
async function readCapped(request: Request): Promise<string> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

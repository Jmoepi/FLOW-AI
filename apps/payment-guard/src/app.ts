import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { createTokenVerifier } from "./auth";
import { createErrorHandler, ERROR_BODIES, notFoundHandler, sendError } from "./http/errors";
import { SECURITY_HEADERS } from "./http/headers";
import { registerInternalRoutes, registerPublicRoutes } from "./http/routes";
import type { ServiceDeps } from "./services/payments";
export interface RouteInfo {
  method: string;
  url: string;
}
export interface GuardApp {
  app: FastifyInstance;
  /** Every registered route, for the auth-coverage test (AZ-1). */
  routes: readonly RouteInfo[];
}
/** Builds the HTTP app. No socket is opened here, so tests drive it with `app.inject`. */
export async function buildApp(deps: ServiceDeps): Promise<GuardApp> {
  const app = Fastify({
    logger: false, // one redacted logger (G-3); never the framework's request logger
    bodyLimit: 100_000,
    genReqId: () => randomUUID(),
    requestIdHeader: false, // client-supplied request ids are ignored
    trustProxy: false,
    routerOptions: { maxParamLength: 64 },
  });
  const routes: RouteInfo[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ method: m, url: r.url });
  });
  // JSON only: drop the built-in text/plain parser so every other content type is a 415.
  app.removeContentTypeParser("text/plain");
  app.setErrorHandler(createErrorHandler(deps.logger));
  app.setNotFoundHandler(notFoundHandler);
  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-request-id", req.id);
    done();
  });
  app.addHook("onSend", (_req, reply, payload, done) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    done(null, payload);
  });
  await app.register(rateLimit, {
    global: true,
    max: deps.config.rateLimitPerMinute,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ statusCode: 429, ...ERROR_BODIES[429] }),
  });
  registerPublicRoutes(app, deps);
  const verify = createTokenVerifier(deps.config.tokens);
  await app.register((internal, _opts, done) => {
    internal.addHook("onRequest", (req, reply, hookDone) => {
      if (!verify(req.headers.authorization)) {
        void sendError(reply, 401);
        return;
      }
      hookDone();
    });
    registerInternalRoutes(internal, deps);
    done();
  });
  await app.ready();
  return { app, routes };
}

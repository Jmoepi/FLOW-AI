import { LoginSchema } from "@flow-ai/contracts";
import { getMembership, withWebUserTx } from "@flow-ai/database";
import { checkLoginRate } from "../auth/rate-limit";
import { presentedToken } from "../auth/session";
import { clearedSessionCookie, endSession, issueSession, sessionCookie, sha256Hex } from "../auth/sessions";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const GENERIC = (): HttpError => new HttpError(401, "INVALID_CREDENTIALS", "The email or password is not correct.");
/**
 * POST /api/auth/login. Every failure (unknown email, wrong password, locked account, no membership) returns the same
 * 401 body. Too many attempts return 429 with Retry-After. A successful login always issues a NEW session id and revokes
 * any session presented with the request (no session fixation).
 */
export const loginRoute = defineRoute({
  method: "POST",
  path: "/api/auth/login",
  role: "public",
  csrf: "origin",
  body: LoginSchema,
  handler: async ({ deps, request, body, ip }) => {
    const rate = await checkLoginRate(deps, ip, body.email);
    if (!rate.allowed) {
      deps.logger.warn("auth.rate_limited", {});
      throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Try again later.", { headers: { "retry-after": String(rate.retryAfterSeconds) } });
    }
    const user = await deps.provider.authenticate(body.email, body.password);
    if (user === null) {
      deps.logger.info("auth.login_failed", {});
      throw GENERIC();
    }
    const membership = await withWebUserTx(deps.pool, user.userId, (c) => getMembership(c, user.userId));
    if (membership === null) {
      deps.logger.info("auth.login_failed", {});
      throw GENERIC();
    }
    const ua = request.headers.get("user-agent");
    const issued = await issueSession(deps, {
      userId: user.userId,
      businessId: membership.business_id,
      role: membership.role,
      ipHash: sha256Hex(`ip:${ip}`),
      uaHash: ua === null ? null : sha256Hex(`ua:${ua.slice(0, 512)}`),
      previousToken: presentedToken(deps, request),
    });
    deps.logger.info("auth.login_succeeded", { role: membership.role });
    return jsonResponse(200, { role: membership.role, csrf_token: issued.csrfToken }, { "set-cookie": sessionCookie(issued.token, deps.config.cookieSecure, issued.maxAgeSeconds) });
  },
});
export const logoutRoute = defineRoute({
  method: "POST",
  path: "/api/auth/logout",
  role: "member",
  csrf: "token",
  handler: async ({ deps, session }) => {
    await endSession(deps, session.sessionId);
    return jsonResponse(200, { ok: true }, { "set-cookie": clearedSessionCookie(deps.config.cookieSecure) });
  },
});
/** Who am I, and the CSRF token to send with writes. Never returns the user id, session id or business id. */
export const sessionRoute = defineRoute({
  method: "GET",
  path: "/api/session",
  role: "member",
  handler: ({ deps, session }) => {
    const ageMs = deps.now().getTime() - session.authenticatedAt.getTime();
    return Promise.resolve(
      jsonResponse(200, {
        role: session.role,
        csrf_token: session.csrfToken,
        reauth_required: ageMs > deps.config.stepUpSeconds * 1000,
        authenticated_at: session.authenticatedAt.toISOString(),
      }),
    );
  },
});

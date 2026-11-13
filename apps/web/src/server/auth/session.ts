import type { WebDeps } from "../deps";
import type { SessionContext } from "./provider";
import { cookieName, readCookie, resolveSession } from "./sessions";
/** The cookie token presented with this request, if any (not yet validated). */
export function presentedToken(deps: WebDeps, request: Request): string | undefined {
  return readCookie(request.headers.get("cookie"), cookieName(deps.config.cookieSecure));
}
/**
 * The ONLY source of authorization input (AZ-1, AZ-2): the server-side session behind the cookie.
 * Returns null when the cookie is missing, malformed, unknown, revoked or expired.
 */
export async function getSessionContext(deps: WebDeps, request: Request): Promise<SessionContext | null> {
  return resolveSession(deps, presentedToken(deps, request));
}
/** True when the user authenticated recently enough for a sensitive write (AU-6). */
export function isFresh(deps: WebDeps, session: SessionContext): boolean {
  return deps.now().getTime() - session.authenticatedAt.getTime() <= deps.config.stepUpSeconds * 1000;
}

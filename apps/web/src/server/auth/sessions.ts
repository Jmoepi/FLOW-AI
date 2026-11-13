import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSession, getSessionByHash, revokeAllSessionsForUser, revokeSession, touchSession, type WebRole } from "@flow-ai/database";
import type { WebDeps } from "../deps";
import type { SessionContext } from "./provider";
/** 256-bit random token, base64url (43 chars). Only its sha256 is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export const hashToken = sha256Hex;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);
/**
 * Synchronizer token for CSRF, derived from the session token with HMAC. It is stable for the life of the session (so
 * several tabs agree), changes on every login (rotation), is never stored (only its sha256 is), and an attacker without
 * the HttpOnly cookie cannot compute it.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("flow-ai:csrf:v1").digest("base64url");
}
export const COOKIE_NAME_SECURE = "__Host-flow_session";
export const COOKIE_NAME_PLAIN = "flow_session";
export const cookieName = (secure: boolean): string => (secure ? COOKIE_NAME_SECURE : COOKIE_NAME_PLAIN);
/** HttpOnly, SameSite=Lax, Path=/, no Domain (so __Host- is valid), Secure whenever the app is served over https. */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}${secure ? "; Secure" : ""}`;
}
export function clearedSessionCookie(secure: boolean): string {
  return `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}
/** Reads one cookie by exact name from a Cookie header. Returns undefined when absent or duplicated (ambiguous). */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null || header.length > 8192) return undefined;
  const found: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) found.push(part.slice(eq + 1).trim());
  }
  return found.length === 1 ? found[0] : undefined;
}
export interface NewLogin {
  userId: string;
  businessId: string;
  role: WebRole;
  ipHash: string | null;
  uaHash: string | null;
  /** Token of a session presented with the login request: revoked (rotation, no session fixation). */
  previousToken?: string | undefined;
}
export interface IssuedSession {
  token: string;
  csrfToken: string;
  maxAgeSeconds: number;
}
/** Creates a fresh session (new random id), revoking any session that was presented. */
export async function issueSession(deps: WebDeps, login: NewLogin): Promise<IssuedSession> {
  const now = deps.now();
  if (login.previousToken !== undefined && isWellFormedToken(login.previousToken)) await revokeSession(deps.pool, hashToken(login.previousToken), now);
  const token = newSessionToken();
  const csrfToken = csrfTokenFor(token);
  const maxAgeSeconds = deps.config.sessionAbsoluteSeconds;
  await createSession(deps.pool, {
    id_hash: hashToken(token),
    user_id: login.userId,
    business_id: login.businessId,
    role: login.role,
    csrf_hash: sha256Hex(csrfToken),
    now,
    absolute_expires_at: new Date(now.getTime() + maxAgeSeconds * 1000),
    ip_hash: login.ipHash,
    ua_hash: login.uaHash,
  });
  return { token, csrfToken, maxAgeSeconds };
}
/** Re-touch at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 30_000;
/** Looks the token up and enforces revocation, absolute expiry and idle expiry on the server. Null for anything invalid. */
export async function resolveSession(deps: WebDeps, token: string | undefined): Promise<SessionContext | null> {
  if (token === undefined || !isWellFormedToken(token)) return null;
  const idHash = hashToken(token);
  const row = await getSessionByHash(deps.pool, idHash);
  if (row === null || row.revoked_at !== null) return null;
  const now = deps.now().getTime();
  if (Date.parse(row.absolute_expires_at) <= now) return null;
  const lastSeen = Date.parse(row.last_seen_at);
  if (lastSeen + deps.config.sessionIdleSeconds * 1000 <= now) return null;
  if (now - lastSeen >= TOUCH_INTERVAL_MS) await touchSession(deps.pool, idHash, deps.now());
  return {
    userId: row.user_id,
    businessId: row.business_id,
    role: row.role,
    sessionId: idHash,
    authenticatedAt: new Date(row.authenticated_at),
    csrfHash: row.csrf_hash,
    csrfToken: csrfTokenFor(token),
  };
}
export async function endSession(deps: WebDeps, sessionId: string): Promise<void> {
  await revokeSession(deps.pool, sessionId, deps.now());
}
export async function endAllSessions(deps: WebDeps, userId: string): Promise<number> {
  return revokeAllSessionsForUser(deps.pool, userId, deps.now());
}

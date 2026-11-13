/**
 * Provider boundary (AU-1 exception, docs/m4-notes.md). Everything outside this file and local-password-provider.ts only
 * sees a verified user id and, per request, a SessionContext. M6 replaces the provider with Supabase Auth; the
 * authorization code, handlers and tests are untouched.
 */
export interface AuthProvider {
  /** Returns the user id, or null for ANY failure (unknown user, wrong password, locked). Never says which. */
  authenticate(email: string, password: string): Promise<{ userId: string } | null>;
}
/** The only authorization input. Built from the server-side session, never from a request body or header. */
export interface SessionContext {
  userId: string;
  businessId: string;
  role: "owner" | "viewer";
  /** sha256 of the session token (the session row key). */
  sessionId: string;
  authenticatedAt: Date;
  /** sha256 hex of the CSRF token. */
  csrfHash: string;
  /** The CSRF token itself, derived from the cookie token. Only GET /api/session returns it. */
  csrfToken: string;
}

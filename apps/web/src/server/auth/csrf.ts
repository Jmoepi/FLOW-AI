import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./sessions";
export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method.toUpperCase());
function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
/**
 * Origin check for state-changing requests. The Origin header must equal the app origin exactly. When a browser sends
 * no Origin, the request is only accepted if the browser itself says it is same-origin (Sec-Fetch-Site). Anything else,
 * including a missing Origin from a non-browser client, is refused.
 */
export function originAllowed(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === appOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}
/** Synchronizer-token check: the header value's sha256 must equal the hash stored on the session. */
export function csrfTokenValid(request: Request, storedHash: string): boolean {
  const token = request.headers.get(CSRF_HEADER);
  if (token === null || token.length < 20 || token.length > 128) return false;
  return equalHex(sha256Hex(token), storedHash);
}

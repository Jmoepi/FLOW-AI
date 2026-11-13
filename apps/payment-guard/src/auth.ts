import { createHash, timingSafeEqual } from "node:crypto";
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
/** Constant-time string comparison: hash both sides to equal length, then timingSafeEqual (SV-1). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
// Printable ASCII only, bounded: no whitespace tricks, no huge inputs hashed.
const BEARER = /^Bearer ([\x21-\x7e]{1,512})$/;
/** Returns a verifier for the Authorization header value. Checks every configured token without short-circuiting. */
export function createTokenVerifier(tokens: readonly string[]): (header: unknown) => boolean {
  return (header) => {
    const match = typeof header === "string" ? BEARER.exec(header) : null;
    const presented = match?.[1] ?? "";
    let ok = false;
    for (const t of tokens) ok = safeEqual(presented, t) || ok;
    return match !== null && ok;
  };
}

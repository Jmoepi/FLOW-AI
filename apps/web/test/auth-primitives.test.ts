import { describe, expect, it } from "vitest";
import { CSRF_HEADER, csrfTokenValid, isSafeMethod, originAllowed } from "../src/server/auth/csrf";
import { DEFAULT_PARAMS, dummyHash, hashPassword, needsRehash, verifyPassword } from "../src/server/auth/password";
import { clientIp } from "../src/server/auth/rate-limit";
import {
  clearedSessionCookie,
  csrfTokenFor,
  hashToken,
  isWellFormedToken,
  newSessionToken,
  readCookie,
  sessionCookie,
  sha256Hex,
} from "../src/server/auth/sessions";
import { FAST, ORIGIN, newPassword } from "./helpers";
describe("password hashing (AU-2)", () => {
  it("hashes with the stated default cost and verifies", async () => {
    expect(DEFAULT_PARAMS).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    const pw = newPassword();
    const h = await hashPassword(pw);
    expect(h.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(h).not.toContain(pw);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword(`${pw}x`, h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  }, 30_000);
  it("salts: the same password hashes differently each time", async () => {
    const pw = newPassword();
    const [a, b] = await Promise.all([hashPassword(pw, FAST), hashPassword(pw, FAST)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(pw, a)).toBe(true);
    expect(await verifyPassword(pw, b)).toBe(true);
  });
  it("verifies a hash written in the documented stored format", async () => {
    // Pins the stored format (scrypt$N$r$p$salt$key, base64) and that the key length comes from the stored hash.
    const { scryptSync } = await import("node:crypto");
    const salt = Buffer.from("flow-ai-test-salt");
    const key = scryptSync("correct horse battery", salt, 16, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
  });
  it("rejects too short or too long passwords when hashing, and over-long ones when verifying", async () => {
    await expect(hashPassword("short", FAST)).rejects.toThrow(RangeError);
    await expect(hashPassword("x".repeat(257), FAST)).rejects.toThrow(RangeError);
    const h = await hashPassword(newPassword(), FAST);
    expect(await verifyPassword("x".repeat(100_000), h)).toBe(false);
  });
  it("treats malformed or hostile stored hashes as a failed login, never as an allocation", async () => {
    const pw = newPassword();
    for (const bad of ["", "plain", "scrypt$1$8$1$AAAA$AAAA", "scrypt$1099511627776$8$1$AAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "scrypt$1000$8$1$AAAA$AAAA", "scrypt$1024$99$1$AAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "bcrypt$1024$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword(pw, bad), bad).toBe(false);
    }
  });
  it("flags weaker stored parameters for rehash", async () => {
    expect(needsRehash(await hashPassword(newPassword(), FAST))).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });
  it("produces a verifiable dummy hash (constant-work path for unknown users)", async () => {
    const d = await dummyHash(FAST);
    expect(d.startsWith("scrypt$1024$")).toBe(true);
    expect(await verifyPassword(newPassword(), d)).toBe(false);
  });
});
describe("session tokens and cookies (AU-3)", () => {
  it("issues 256-bit url-safe tokens that never repeat and stores only a sha256", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(a)).toBe(true);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken(`${a}!`)).toBe(false);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
  it("sets HttpOnly, SameSite=Lax, Path=/ and no Domain; Secure with the __Host- prefix over https", () => {
    const plain = sessionCookie("tok", false, 100);
    expect(plain).toBe("flow_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=100");
    const secure = sessionCookie("tok", true, 100);
    expect(secure.startsWith("__Host-flow_session=tok;")).toBe(true);
    for (const c of [plain, secure]) {
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Lax");
      expect(c).toContain("Path=/");
      expect(c).not.toMatch(/Domain=/i);
    }
    expect(secure.endsWith("; Secure")).toBe(true);
    expect(plain).not.toContain("Secure");
    expect(clearedSessionCookie(true)).toContain("Max-Age=0");
    expect(clearedSessionCookie(true)).toContain("HttpOnly");
  });
  it("reads exactly one cookie by name and refuses ambiguity", () => {
    expect(readCookie("a=1; flow_session=abc; b=2", "flow_session")).toBe("abc");
    expect(readCookie("flow_session=abc; flow_session=def", "flow_session")).toBeUndefined();
    expect(readCookie("xflow_session=abc", "flow_session")).toBeUndefined();
    expect(readCookie(null, "flow_session")).toBeUndefined();
    expect(readCookie("flow_session=abc", "__Host-flow_session")).toBeUndefined();
    expect(readCookie(`flow_session=${"x".repeat(9000)}`, "flow_session")).toBeUndefined();
  });
  it("derives a stable per-session CSRF token that differs between sessions", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(csrfTokenFor(a)).toBe(csrfTokenFor(a));
    expect(csrfTokenFor(a)).not.toBe(csrfTokenFor(b));
    expect(csrfTokenFor(a)).not.toContain(a);
  });
});
describe("CSRF (AU-4)", () => {
  const post = (headers: Record<string, string>): Request => new Request(`${ORIGIN}/api/policy`, { method: "PUT", headers });
  it("accepts only the exact app origin; a missing Origin needs Sec-Fetch-Site: same-origin", () => {
    expect(originAllowed(post({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(originAllowed(post({ origin: "http://evil.example" }), ORIGIN)).toBe(false);
    expect(originAllowed(post({ origin: `${ORIGIN}.evil.example` }), ORIGIN)).toBe(false);
    expect(originAllowed(post({ origin: "null" }), ORIGIN)).toBe(false);
    expect(originAllowed(post({}), ORIGIN)).toBe(false);
    expect(originAllowed(post({ "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(true);
    expect(originAllowed(post({ "sec-fetch-site": "cross-site" }), ORIGIN)).toBe(false);
    expect(originAllowed(post({ origin: "http://evil.example", "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(false);
  });
  it("validates the synchronizer token against the stored hash", () => {
    const token = csrfTokenFor(newSessionToken());
    const stored = sha256Hex(token);
    expect(csrfTokenValid(post({ [CSRF_HEADER]: token }), stored)).toBe(true);
    expect(csrfTokenValid(post({ [CSRF_HEADER]: `${token}x` }), stored)).toBe(false);
    expect(csrfTokenValid(post({ [CSRF_HEADER]: csrfTokenFor(newSessionToken()) }), stored)).toBe(false);
    expect(csrfTokenValid(post({}), stored)).toBe(false);
    expect(csrfTokenValid(post({ [CSRF_HEADER]: "" }), stored)).toBe(false);
  });
  it("treats GET, HEAD and OPTIONS as safe and everything else as state-changing", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(isSafeMethod(m)).toBe(true);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(isSafeMethod(m)).toBe(false);
  });
});
describe("client IP", () => {
  const req = (xff?: string): Request => new Request(`${ORIGIN}/api/x`, { headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  it("ignores X-Forwarded-For unless the proxy is trusted, and validates it when it is", () => {
    expect(clientIp(req("1.2.3.4"), false)).toBe("direct");
    expect(clientIp(req("1.2.3.4, 5.6.7.8"), true)).toBe("1.2.3.4");
    expect(clientIp(req("not an ip; drop table"), true)).toBe("direct");
    expect(clientIp(req(), true)).toBe("direct");
  });
});

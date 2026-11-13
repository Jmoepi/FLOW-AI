import { describe, expect, it } from "vitest";
import { buildCsp, buildSecurityHeaders, newNonce, runtimeMode } from "../src/server/security-headers";
const NONCE = "bm9uY2UtMTIzNDU2Nzg5MA==";
describe("security headers", () => {
  const prod = buildSecurityHeaders(NONCE, "production");
  const csp = (prod["content-security-policy"] ?? "").split("; ");
  const directive = (name: string): string => csp.find((d) => d.startsWith(`${name} `)) ?? "";
  it("production script-src has the nonce and no unsafe-inline or unsafe-eval", () => {
    const script = directive("script-src");
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
    expect(directive("style-src")).not.toContain("unsafe-inline");
  });
  it("locks down framing, objects, base and form targets", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(prod["x-frame-options"]).toBe("DENY");
  });
  it("sets the fixed browser headers", () => {
    expect(prod["x-content-type-options"]).toBe("nosniff");
    expect(prod["referrer-policy"]).toBe("no-referrer");
    expect(prod["cross-origin-opener-policy"]).toBe("same-origin");
    expect(prod["cache-control"]).toBe("no-store");
    for (const f of ["camera", "microphone", "geolocation", "payment", "usb"]) expect(prod["permissions-policy"]).toContain(`${f}=()`);
    expect(Object.keys(prod)).not.toContain("x-powered-by");
  });
  it("sends HSTS only in production", () => {
    expect(prod["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(buildSecurityHeaders(NONCE, "development")["strict-transport-security"]).toBeUndefined();
    expect(buildSecurityHeaders(NONCE, "test")["strict-transport-security"]).toBeUndefined();
  });
  it("allows unsafe-eval only in development", () => {
    expect(buildCsp(NONCE, "development")).toContain("'unsafe-eval'");
    expect(buildCsp(NONCE, "test")).not.toContain("unsafe-eval");
    expect(buildCsp(NONCE, "production")).not.toContain("unsafe-eval");
  });
  it("maps NODE_ENV to a mode and fails toward the strict, non-dev policy", () => {
    expect(runtimeMode("production")).toBe("production");
    expect(runtimeMode("development")).toBe("development");
    expect(runtimeMode(undefined)).toBe("test");
    expect(runtimeMode("anything-else")).toBe("test");
  });
  it("generates a fresh 128-bit nonce on every call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(Buffer.from(n, "base64")).toHaveLength(16);
  });
});

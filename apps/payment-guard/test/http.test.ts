import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../src/http/headers";
import { TOKEN, bearer, makeApp } from "./helpers";
const UUID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";
const good = { invoice_id: UUID, idempotency_key: "run-1:inv-0001" };
const post = (app: Awaited<ReturnType<typeof makeApp>>["app"], payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/internal/payment-requests", headers: { ...bearer(), "content-type": "application/json", ...headers }, payload: payload as string });
const noLeak = (body: string) => expect(body).not.toMatch(/stack|select |insert |node_modules|[A-Za-z]:\\|at \w+ \(|fastify|postgres/i);
describe("authentication", () => {
  it("returns the identical fixed 401 body for missing and invalid tokens", async () => {
    const { app } = await makeApp();
    const missing = await app.inject({ method: "GET", url: "/internal/status" });
    const wrong = await app.inject({ method: "GET", url: "/internal/status", headers: bearer("x".repeat(40)) });
    const basic = await app.inject({ method: "GET", url: "/internal/status", headers: { authorization: `Basic ${TOKEN}` } });
    for (const r of [missing, wrong, basic]) {
      expect(r.statusCode).toBe(401);
      expect(r.body).toBe('{"error":"unauthorized"}');
    }
    expect(missing.body).toBe(wrong.body);
  });
  it("covers every /internal route with the auth hook", async () => {
    const { app, routes } = await makeApp();
    const internal = routes.filter((r) => r.url.startsWith("/internal/"));
    expect(internal.length).toBeGreaterThanOrEqual(6);
    for (const r of internal) {
      const res = await app.inject({ method: r.method as "GET" | "POST", url: r.url.replace(":id", UUID) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });
  it("leaves only the health probes open", async () => {
    const { app, routes } = await makeApp();
    expect(routes.filter((r) => !r.url.startsWith("/internal/")).map((r) => r.url).sort()).toEqual(["/healthz", "/readyz"]);
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });
  it("readyz reports unavailable without leaking the cause", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", db: false, ledger: false, audit_chain: "unverified", audit_verified_at: null });
    noLeak(res.body);
  });
});
describe("request hardening", () => {
  it("rejects unknown keys with 400 and never echoes them", async () => {
    const { app } = await makeApp();
    for (const extra of [{ amount: "999" }, { destination: "rEvil" }, { business_id: UUID }, { tx_blob: "AB" }]) {
      const res = await post(app, JSON.stringify({ ...good, ...extra }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_REQUEST" });
      expect(res.body).not.toMatch(/999|rEvil|tx_blob|amount/);
    }
  });
  it("rejects __proto__, SQL strings, control characters and long reasons", async () => {
    const { app } = await makeApp();
    const bodies = [
      '{"invoice_id":"' + UUID + '","idempotency_key":"run-1:inv-0001","__proto__":{"admin":true}}',
      JSON.stringify({ ...good, invoice_id: "1'; DROP TABLE payments;--" }),
      JSON.stringify({ ...good, idempotency_key: "k'; DROP TABLE x;--" }),
      JSON.stringify({ ...good, agent_reason: "bad\u0007char" }),
      JSON.stringify({ ...good, agent_reason: "a".repeat(281) }),
      "{not json",
      "",
    ];
    for (const b of bodies) {
      const res = await post(app, b);
      expect(res.statusCode, b.slice(0, 40)).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_REQUEST" });
    }
  });
  it("rejects an oversized body with 413", async () => {
    const { app } = await makeApp();
    const res = await post(app, JSON.stringify({ ...good, agent_reason: "a".repeat(5000) }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "payload_too_large" });
  });
  it("rejects non-JSON content types with 415", async () => {
    const { app } = await makeApp();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/xml"]) {
      const res = await post(app, "a=b", { "content-type": type });
      expect(res.statusCode, type).toBe(415);
      expect(res.json()).toEqual({ error: "unsupported_media_type" });
    }
  });
  it("answers 404 for unknown routes and 400 for malformed ids, without detail", async () => {
    const { app } = await makeApp();
    const nf = await app.inject({ method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: "not_found" });
    const bad = await app.inject({ method: "GET", url: "/internal/payments/1;DROP", headers: bearer() });
    expect(bad.statusCode).toBe(400);
    const badQuery = await app.inject({ method: "GET", url: "/internal/payments?limit=1000", headers: bearer() });
    expect(badQuery.statusCode).toBe(400);
    const extraQuery = await app.inject({ method: "GET", url: "/internal/payments?business_id=" + UUID, headers: bearer() });
    expect(extraQuery.statusCode).toBe(400);
    for (const r of [nf, bad, badQuery]) noLeak(r.body);
  });
  it("returns a generic 500 and logs a redacted line when the database fails", async () => {
    const lines: string[] = [];
    const { app } = await makeApp({}, lines);
    const res = await post(app, JSON.stringify(good));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    noLeak(res.body);
    expect(lines.join("\n")).toContain("request.failed");
  });
  it("rate limits with 429 and Retry-After", async () => {
    const { app } = await makeApp({ GUARD_RATE_LIMIT_PER_MINUTE: "3" });
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await app.inject({ method: "GET", url: "/healthz" });
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(last?.json()).toEqual({ error: "rate_limited" });
    expect(last?.headers["retry-after"]).toBeDefined();
  });
});
describe("response headers", () => {
  it("sets the security headers and a server-generated request id on success, errors and 404", async () => {
    const { app } = await makeApp();
    for (const res of [await app.inject({ method: "GET", url: "/healthz" }), await app.inject({ method: "GET", url: "/internal/status" }), await app.inject({ method: "GET", url: "/nope" })]) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers[k], k).toBe(v);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("matches the header snapshot", () => {
    expect(SECURITY_HEADERS).toEqual({
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "strict-transport-security": "max-age=63072000; includeSubDomains",
    });
  });
});

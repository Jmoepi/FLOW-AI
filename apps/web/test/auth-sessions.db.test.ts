import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredential } from "@flow-ai/database";
import { credentialState, listSessionHashes, sessionRevokedAt } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { LOGIN_LIMITS, LOGIN_WINDOW_SECONDS } from "../src/server/auth/rate-limit";
import { hashPassword } from "../src/server/auth/password";
import { endAllSessions, hashToken } from "../src/server/auth/sessions";
import { FAST, ORIGIN, createWebHarness, newPassword, type WebHarness } from "./helpers";
let h: WebHarness;
beforeAll(async () => {
  h = await createWebHarness();
});
afterAll(async () => {
  await h.close();
});
const tokenOf = (cookie: string): string => cookie.split("=")[1] ?? "";
describe("login and cookies", () => {
  it("logs in, sets a hardened cookie and stores only the token hash", async () => {
    const s = await h.login(h.owner);
    const setCookie = s.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^flow_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(s.body.role).toBe("owner");
    expect(JSON.stringify(s.body)).not.toContain(tokenOf(s.cookie));
    const hashes = await listSessionHashes(h.db.adminPool);
    expect(hashes).toContain(hashToken(tokenOf(s.cookie)));
    expect(JSON.stringify(hashes)).not.toContain(tokenOf(s.cookie));
    expect(s.headers.get("cache-control")).toBe("no-store");
  });
  it("uses __Host- and Secure when the app is served over https", async () => {
    const secure = await createWebHarness({ env: { APP_BASE_URL: "https://app.example.com" } });
    try {
      const res = await secure.call(routes.login, { body: { email: secure.owner.email, password: secure.owner.password }, origin: "https://app.example.com" });
      expect(res.status).toBe(200);
      const c = res.headers.get("set-cookie") ?? "";
      expect(c.startsWith("__Host-flow_session=")).toBe(true);
      expect(c).toContain("; Secure");
      expect(c).toContain("HttpOnly");
    } finally {
      await secure.close();
    }
  });
  it("returns the CSRF token and no identifiers from GET /api/session", async () => {
    const s = await h.login(h.owner);
    const res = await h.call(routes.session, { cookie: s.cookie });
    expect(res.status).toBe(200);
    expect(res.body.csrf_token).toBe(s.csrf);
    expect(res.body.role).toBe("owner");
    expect(res.raw).not.toContain(h.owner.userId);
    expect(res.raw).not.toContain(h.scenario.businessId);
  });
});
describe("session lifecycle (AU-3)", () => {
  it("expires after the idle timeout, but activity keeps it alive", async () => {
    const s = await h.login(h.owner);
    h.clock.advance(h.config.sessionIdleSeconds - 60);
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(200);
    h.clock.advance(h.config.sessionIdleSeconds - 60);
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(200);
    h.clock.advance(h.config.sessionIdleSeconds + 1);
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(401);
  });
  it("expires at the absolute timeout even with constant activity", async () => {
    const s = await h.login(h.owner);
    const step = h.config.sessionIdleSeconds - 60;
    let elapsed = 0;
    while (elapsed + step < h.config.sessionAbsoluteSeconds) {
      h.clock.advance(step);
      elapsed += step;
      expect((await h.call(routes.session, { cookie: s.cookie })).status, `at ${String(elapsed)}s`).toBe(200);
    }
    h.clock.advance(h.config.sessionAbsoluteSeconds - elapsed + 1);
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(401);
  });
  it("rotates on login: a new id is issued and the presented session is revoked (no fixation)", async () => {
    const first = await h.login(h.owner);
    const second = await h.login(h.owner, { cookie: first.cookie });
    expect(tokenOf(second.cookie)).not.toBe(tokenOf(first.cookie));
    expect((await h.call(routes.session, { cookie: first.cookie })).status).toBe(401);
    expect((await h.call(routes.session, { cookie: second.cookie })).status).toBe(200);
  });
  it("never accepts an attacker-chosen session id", async () => {
    const chosen = "A".repeat(43);
    const res = await h.call(routes.login, { body: { email: h.owner.email, password: h.owner.password }, cookie: `flow_session=${chosen}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain(chosen);
    expect((await h.call(routes.session, { cookie: `flow_session=${chosen}` })).status).toBe(401);
  });
  it("logout revokes the session server-side and clears the cookie", async () => {
    const s = await h.login(h.owner);
    const res = await h.authed(routes.logout, s);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(401);
    expect(await sessionRevokedAt(h.db.adminPool, hashToken(tokenOf(s.cookie)))).toBeInstanceOf(Date);
  });
  it("revoke-all ends every session of a user and leaves other users alone", async () => {
    const a = await h.login(h.owner);
    const b = await h.login(h.owner);
    const other = await h.login(h.viewer);
    expect(await endAllSessions(h.deps, h.owner.userId)).toBeGreaterThanOrEqual(2);
    expect((await h.call(routes.session, { cookie: a.cookie })).status).toBe(401);
    expect((await h.call(routes.session, { cookie: b.cookie })).status).toBe(401);
    expect((await h.call(routes.session, { cookie: other.cookie })).status).toBe(200);
  });
  it("reports reauth_required once the login is older than the step-up window", async () => {
    const s = await h.login(h.owner);
    expect((await h.call(routes.session, { cookie: s.cookie })).body.reauth_required).toBe(false);
    h.clock.advance(h.config.stepUpSeconds + 1);
    expect((await h.call(routes.session, { cookie: s.cookie })).body.reauth_required).toBe(true);
  });
  it("rejects malformed, truncated, duplicated and unknown cookies", async () => {
    const s = await h.login(h.owner);
    const t = tokenOf(s.cookie);
    for (const cookie of ["", "flow_session=", `flow_session=${t.slice(1)}`, `flow_session=${t}x`, `flow_session=${t}; flow_session=${t}`, `flow_session=${"B".repeat(43)}`, `flow_session=${t}'; DROP TABLE web_sessions;--`]) {
      expect((await h.call(routes.session, { cookie })).status, cookie).toBe(401);
    }
  });
});
describe("login failures are indistinguishable (AU-5)", () => {
  it("unknown user, wrong password, no membership and bad shape give the same generic 401", async () => {
    await createCredential(h.db.adminPool, { email: "orphan@example.test", password_hash: await hashPassword(h.owner.password, FAST) });
    const attempts = [
      { email: "nobody@example.test", password: newPassword() },
      { email: h.owner.email, password: newPassword() },
      { email: h.owner.email.toUpperCase(), password: newPassword() },
    ];
    const results = [];
    for (const a of attempts) results.push(await h.call(routes.login, { body: a }));
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("INVALID_CREDENTIALS");
      expect(r.body.message).toBe(results[0]?.body.message);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect(Object.keys(results[0]?.body ?? {}).sort()).toEqual(Object.keys(results[1]?.body ?? {}).sort());
    const noMember = await h.call(routes.login, { body: { email: "orphan@example.test", password: h.owner.password } });
    expect(noMember.status).toBe(401);
    expect(noMember.body.code).toBe("INVALID_CREDENTIALS");
    expect(noMember.body.message).toBe(results[0]?.body.message);
  });
  it("locks the account with backoff after repeated failures, even for the right password, then recovers", async () => {
    const victim = await h.addUser(h.scenario.businessId, "owner");
    for (let i = 0; i < 5; i++) expect((await h.call(routes.login, { body: { email: victim.email, password: newPassword() } })).status).toBe(401);
    const locked = await h.call(routes.login, { body: { email: victim.email, password: victim.password } });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe("INVALID_CREDENTIALS");
    h.clock.advance(31);
    expect((await h.call(routes.login, { body: { email: victim.email, password: victim.password } })).status).toBe(200);
    // success resets the counter
    expect(await credentialState(h.db.adminPool, victim.userId)).toEqual({ failed_count: 0, locked_until: null });
  });
  it("doubles the lock on each further failure, capped", async () => {
    const victim = await h.addUser(h.scenario.businessId, "owner");
    const lockSeconds = async (): Promise<number> => {
      const st = await credentialState(h.db.adminPool, victim.userId);
      return Math.round(((st.locked_until ?? 0) - h.clock.ms) / 1000);
    };
    for (let i = 0; i < 5; i++) await h.call(routes.login, { body: { email: victim.email, password: newPassword() } });
    expect(await lockSeconds()).toBe(30);
    h.clock.advance(31);
    await h.call(routes.login, { body: { email: victim.email, password: newPassword() } });
    expect(await lockSeconds()).toBe(60);
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1000);
      await h.call(routes.login, { body: { email: victim.email, password: newPassword() } });
    }
    expect(await lockSeconds()).toBe(900);
  });
  it("rate limits attempts per email with 429 and Retry-After, and recovers in the next window", async () => {
    h.clock.advance(LOGIN_WINDOW_SECONDS + 1);
    const email = "flood@example.test";
    let last = await h.call(routes.login, { body: { email, password: newPassword() } });
    for (let i = 1; i < LOGIN_LIMITS.perEmail; i++) last = await h.call(routes.login, { body: { email, password: newPassword() } });
    expect(last.status).toBe(401);
    const blocked = await h.call(routes.login, { body: { email, password: newPassword() } });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(LOGIN_WINDOW_SECONDS);
    // different email is not affected
    expect((await h.call(routes.login, { body: { email: "other-flood@example.test", password: newPassword() } })).status).toBe(401);
    h.clock.advance(LOGIN_WINDOW_SECONDS + 1);
    expect((await h.call(routes.login, { body: { email, password: newPassword() } })).status).toBe(401);
  });
  it("does not leak passwords or tokens into logs", async () => {
    const pw = newPassword();
    await h.call(routes.login, { body: { email: "logcheck@example.test", password: pw } });
    const s = await h.login(h.owner);
    const hay = h.logs.join("\n");
    expect(hay).not.toContain(pw);
    expect(hay).not.toContain(h.owner.password);
    expect(hay).not.toContain(tokenOf(s.cookie));
    expect(hay).not.toContain(s.csrf);
  });
});
describe("CSRF on login and logout", () => {
  it("login requires the app Origin; logout requires Origin and the token", async () => {
    const body = { email: h.owner.email, password: h.owner.password };
    expect((await h.call(routes.login, { body, origin: "http://evil.example" })).status).toBe(403);
    expect((await h.call(routes.login, { body, origin: null })).status).toBe(403);
    expect((await h.call(routes.login, { body, origin: null, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    const s = await h.login(h.owner);
    expect((await h.call(routes.logout, { cookie: s.cookie })).status).toBe(403);
    expect((await h.call(routes.logout, { cookie: s.cookie, csrf: "x".repeat(43) })).status).toBe(403);
    expect((await h.call(routes.logout, { cookie: s.cookie, csrf: s.csrf, origin: "http://evil.example" })).status).toBe(403);
    expect((await h.call(routes.session, { cookie: s.cookie })).status).toBe(200);
    expect((await h.call(routes.logout, { cookie: s.cookie, csrf: s.csrf, origin: ORIGIN })).status).toBe(200);
  });
  it("a CSRF token from another session is refused", async () => {
    const a = await h.login(h.owner);
    const b = await h.login(h.viewer);
    expect((await h.call(routes.logout, { cookie: a.cookie, csrf: b.csrf })).status).toBe(403);
  });
});

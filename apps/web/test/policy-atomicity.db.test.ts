import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPolicyForWeb, listAuditForBusiness, listSuppliersForBusiness, verifyAuditChain } from "@flow-ai/database";
import { installAuditFailure, removeAuditFailure } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { CURRENCY_HEX, ISSUER, createWebHarness, type Session, type TestUser, type WebHarness } from "./helpers";
let h: WebHarness;
let s: Session;
let owner: TestUser;
const body = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  max_payment_amount: "2",
  daily_spend_limit: "3",
  minimum_reserve: "0",
  allowed_assets: [{ currency: CURRENCY_HEX, issuer: ISSUER }],
  valid_until: null,
  ...over,
});
const policy = () => getPolicyForWeb(h.db.adminPool, h.scenario.businessId);
const events = async () => (await listAuditForBusiness(h.db.adminPool, h.scenario.businessId, { limit: 100 })).filter((e) => e.event_type === "policy.updated");
const put = async (version: number | string | null, b: unknown, session: Session = s) =>
  h.authed(routes.policyPut, session, { body: b, headers: version === null ? {} : { "if-match": typeof version === "number" ? `"${String(version)}"` : version } });
beforeAll(async () => {
  h = await createWebHarness();
});
afterAll(async () => {
  await h.close();
});
// A fresh owner per test: each has its own login bucket and a fresh authenticated_at, whatever earlier tests did to the clock.
beforeEach(async () => {
  owner = await h.addUser(h.scenario.businessId, "owner");
  s = await h.login(owner);
});
describe("same-transaction audit (AU: policy change and event commit together)", () => {
  it("a successful update bumps the version once and writes exactly one audit event with the diff", async () => {
    const before = (await policy())!;
    const eventsBefore = (await events()).length;
    const res = await put(before.version, body({ max_payment_amount: "1.5" }));
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["max_payment_amount"]);
    expect(res.headers.get("etag")).toBe(`"${String(before.version + 1)}"`);
    const after = (await policy())!;
    expect(after.version).toBe(before.version + 1);
    expect(after.max_payment_amount).toBe("1.5");
    expect(after.updated_by).toBe(owner.userId);
    const evs = await events();
    expect(evs.length).toBe(eventsBefore + 1);
    const ev = evs[0]!;
    expect(ev.metadata).toMatchObject({ changed: ["max_payment_amount"], before: { max_payment_amount: "2" }, after: { max_payment_amount: "1.5" }, risky: false, previous_version: before.version, new_version: after.version });
    expect(ev.actor_type).toBe("human");
    expect(ev.actor_id).toBe(owner.userId);
    expect(ev.request_id).toBe(res.headers.get("x-request-id"));
    expect(await verifyAuditChain(h.db.adminPool, h.scenario.businessId)).toBe(true);
  });
  it("if the audit insert fails, the policy change rolls back: nothing is half-applied", async () => {
    const before = (await policy())!;
    const eventsBefore = (await events()).length;
    await installAuditFailure(h.db.adminPool, "policy.updated");
    try {
      const res = await put(before.version, body({ max_payment_amount: "1.25" }));
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("INTERNAL");
      expect(res.raw).not.toMatch(/forced audit failure/);
    } finally {
      await removeAuditFailure(h.db.adminPool);
    }
    expect(await policy()).toEqual(before);
    expect((await events()).length).toBe(eventsBefore);
    // the same request succeeds once the fault is gone: no stuck lock, no consumed version
    const retry = await put(before.version, body({ max_payment_amount: "1.25" }));
    expect(retry.status).toBe(200);
    expect((await events()).length).toBe(eventsBefore + 1);
    expect(await verifyAuditChain(h.db.adminPool, h.scenario.businessId)).toBe(true);
  });
});
describe("optimistic concurrency (If-Match)", () => {
  it("requires If-Match (428), validates its format (400), and rejects a stale version (412) with the current ETag", async () => {
    const cur = (await policy())!;
    expect((await put(null, body({ max_payment_amount: "0.5" }))).status).toBe(428);
    for (const bad of ["abc", '"abc"', '"-1"', "W/\"1\"", '"01"', '"1" , "2"', '""', '"99999999999"']) {
      expect((await put(bad, body({ max_payment_amount: "0.5" }))).status, bad).toBe(400);
    }
    const stale = await put(cur.version + 5, body({ max_payment_amount: "0.5" }));
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect(stale.headers.get("etag")).toBe(`"${String(cur.version)}"`);
    expect(await policy()).toEqual(cur);
  });
  it("a stale update after a newer one is refused and does not overwrite it", async () => {
    const cur = (await policy())!;
    expect((await put(cur.version, body({ max_payment_amount: "1.1" }))).status).toBe(200);
    const stale = await put(cur.version, body({ max_payment_amount: "1.9" }));
    expect(stale.status).toBe(412);
    expect((await policy())?.max_payment_amount).toBe("1.1");
  });
  it("two concurrent updates with the same version: exactly one wins, one audit event, one version bump", async () => {
    const cur = (await policy())!;
    const eventsBefore = (await events()).length;
    const results = await Promise.all([put(cur.version, body({ max_payment_amount: "1.01" })), put(cur.version, body({ max_payment_amount: "1.02" }))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    const after = (await policy())!;
    expect(after.version).toBe(cur.version + 1);
    expect((await events()).length).toBe(eventsBefore + 1);
    const winner = results.find((r) => r.status === 200)!;
    expect(winner.body.policy.max_payment_amount).toBe(after.max_payment_amount);
  });
  it("two concurrent IDENTICAL updates also produce exactly one success", async () => {
    const cur = (await policy())!;
    const eventsBefore = (await events()).length;
    const same = body({ max_payment_amount: "0.9" });
    const results = await Promise.all([put(cur.version, same), put(cur.version, same), put(cur.version, same)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412, 412]);
    expect((await policy())?.version).toBe(cur.version + 1);
    expect((await events()).length).toBe(eventsBefore + 1);
  });
  it("a no-op update returns 200 and writes no version bump and no audit event", async () => {
    const cur = (await policy())!;
    const eventsBefore = (await events()).length;
    const res = await put(cur.version, body({ max_payment_amount: cur.max_payment_amount, daily_spend_limit: cur.daily_spend_limit, minimum_reserve: cur.minimum_reserve }));
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(await policy()).toEqual(cur);
    expect((await events()).length).toBe(eventsBefore);
  });
});
describe("risky changes, pause and step-up (AU-6)", () => {
  it("loosening needs confirm_risky (422), and with it succeeds and is recorded as confirmed", async () => {
    const cur = (await policy())!;
    const raise = body({ max_payment_amount: "2.5", daily_spend_limit: "9" });
    const refused = await put(cur.version, raise);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(refused.body.risky_fields).toEqual(expect.arrayContaining(["max_payment_amount", "daily_spend_limit"]));
    expect(await policy()).toEqual(cur);
    expect((await put(cur.version, { ...raise, confirm_risky: "yes" })).status).toBe(400);
    const ok = await put(cur.version, { ...raise, confirm_risky: true });
    expect(ok.status).toBe(200);
    expect((await events())[0]?.metadata).toMatchObject({ risky: true, confirmed: true });
    expect((await events())[0]?.metadata).not.toHaveProperty("confirm_risky");
  });
  it("re-enabling after a pause is risky; pausing never needs confirmation", async () => {
    const cur = (await policy())!;
    const paused = await put(cur.version, body({ enabled: false, max_payment_amount: cur.max_payment_amount, daily_spend_limit: cur.daily_spend_limit, minimum_reserve: cur.minimum_reserve }));
    expect(paused.status).toBe(200);
    const v = (await policy())!;
    expect(v.enabled).toBe(false);
    const re = body({ enabled: true, max_payment_amount: v.max_payment_amount, daily_spend_limit: v.daily_spend_limit, minimum_reserve: v.minimum_reserve });
    expect((await put(v.version, re)).status).toBe(422);
    expect((await put(v.version, { ...re, confirm_risky: true })).status).toBe(200);
  });
  it("tightening is not risky", async () => {
    const cur = (await policy())!;
    const res = await put(cur.version, body({ max_payment_amount: "0.1", daily_spend_limit: "0.2", minimum_reserve: "5", valid_until: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(res.status).toBe(200);
  });
  it("an old login cannot change rules (401 REAUTH_REQUIRED) but can still pause", async () => {
    const cur = (await policy())!;
    h.clock.advance(h.config.stepUpSeconds + 5);
    const change = await put(cur.version, body({ max_payment_amount: "0.05", daily_spend_limit: cur.daily_spend_limit, minimum_reserve: cur.minimum_reserve, valid_until: cur.valid_until }));
    expect(change.status).toBe(401);
    expect(change.body.code).toBe("REAUTH_REQUIRED");
    expect(await policy()).toEqual(cur);
    const pause = await put(cur.version, body({ enabled: false, max_payment_amount: cur.max_payment_amount, daily_spend_limit: cur.daily_spend_limit, minimum_reserve: cur.minimum_reserve, valid_until: cur.valid_until }), s);
    expect(pause.status).toBe(200);
    expect((await policy())?.enabled).toBe(false);
    const fresh = await h.login(owner);
    const v = (await policy())!;
    expect((await put(v.version, body({ enabled: false, max_payment_amount: "0.05", daily_spend_limit: v.daily_spend_limit, minimum_reserve: v.minimum_reserve, valid_until: v.valid_until }), fresh)).status).toBe(200);
  });
  it("allowed_assets can only name the configured RLUSD pair", async () => {
    const cur = (await policy())!;
    const other = { currency: "5553444300000000000000000000000000000000", issuer: ISSUER };
    expect((await put(cur.version, body({ allowed_assets: [other], confirm_risky: true }))).status).toBe(400);
    expect((await put(cur.version, body({ allowed_assets: [{ currency: CURRENCY_HEX, issuer: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" }], confirm_risky: true }))).status).toBe(400);
    expect(await policy()).toEqual(cur);
  });
  it("rejects relationship violations and out-of-range values without touching the row", async () => {
    const cur = (await policy())!;
    expect((await put(cur.version, body({ max_payment_amount: "10", daily_spend_limit: "5" }))).status).toBe(400);
    expect((await put(cur.version, body({ valid_until: "2001-01-01T00:00:00Z" }))).status).toBe(400);
    expect((await put(cur.version, body({ daily_spend_limit: "1000000001", max_payment_amount: "1" }))).status).toBe(400);
    expect(await policy()).toEqual(cur);
  });
});
describe("supplier changes", () => {
  it("writes an audit event per changed flag in the same transaction, and nothing for a no-op", async () => {
    const supplier = (await listSuppliersForBusiness(h.db.adminPool, h.scenario.businessId))[0]!;
    const countSupplierEvents = async () => (await listAuditForBusiness(h.db.adminPool, h.scenario.businessId, { limit: 100 })).filter((e) => e.entity_type === "supplier").length;
    const before = await countSupplierEvents();
    const noop = await h.authed(routes.supplierPatch, s, { body: { is_approved: supplier.is_approved }, params: { id: supplier.id } });
    expect(noop.status).toBe(200);
    expect(noop.body.changed).toEqual([]);
    expect(await countSupplierEvents()).toBe(before);
    const res = await h.authed(routes.supplierPatch, s, { body: { is_approved: false, is_active: false }, params: { id: supplier.id } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["is_approved", "is_active"]);
    expect(res.raw).not.toContain(h.scenario.businessId);
    const now = (await listSuppliersForBusiness(h.db.adminPool, h.scenario.businessId))[0]!;
    expect([now.is_approved, now.is_active]).toEqual([false, false]);
    const types = (await listAuditForBusiness(h.db.adminPool, h.scenario.businessId, { limit: 100 })).filter((e) => e.entity_type === "supplier").map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["supplier.approval_changed", "supplier.active_changed"]));
    expect(await countSupplierEvents()).toBe(before + 2);
    expect(res.body.supplier.name).toBe(supplier.name);
  });
  it("approving needs a fresh login; the audit failure rolls the flag back", async () => {
    const supplier = (await listSuppliersForBusiness(h.db.adminPool, h.scenario.businessId))[0]!;
    expect(supplier.is_approved).toBe(false);
    h.clock.advance(h.config.stepUpSeconds + 5);
    const stale = await h.authed(routes.supplierPatch, s, { body: { is_approved: true }, params: { id: supplier.id } });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe("REAUTH_REQUIRED");
    const fresh = await h.login(owner);
    await installAuditFailure(h.db.adminPool, "supplier.approval_changed");
    try {
      expect((await h.authed(routes.supplierPatch, fresh, { body: { is_approved: true }, params: { id: supplier.id } })).status).toBe(500);
    } finally {
      await removeAuditFailure(h.db.adminPool);
    }
    expect((await listSuppliersForBusiness(h.db.adminPool, h.scenario.businessId))[0]?.is_approved).toBe(false);
    expect((await h.authed(routes.supplierPatch, fresh, { body: { is_approved: true }, params: { id: supplier.id } })).status).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPolicyForWeb, listSuppliersForBusiness } from "@flow-ai/database";
import { seedScenario, tableCounts } from "@flow-ai/database/testing";
import { routes } from "../src/server/api/routes";
import { MAX_BODY_BYTES } from "../src/server/http/route";
import { CURRENCY_HEX, ISSUER, createWebHarness, fakeAddress, type Session, type WebHarness } from "./helpers";
let h: WebHarness;
let ownerSession: Session;
let viewerSession: Session;
const policyBody = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  max_payment_amount: "2",
  daily_spend_limit: "3",
  minimum_reserve: "0",
  allowed_assets: [{ currency: CURRENCY_HEX, issuer: ISSUER }],
  valid_until: null,
  ...over,
});
beforeAll(async () => {
  h = await createWebHarness();
  ownerSession = await h.login(h.owner);
  viewerSession = await h.login(h.viewer);
});
afterAll(async () => {
  await h.close();
});
const ownerRoutes = [routes.policyGet, routes.policyPut, routes.suppliersList, routes.supplierPatch, routes.auditList, routes.overview];
const authedRoutes = [...ownerRoutes, routes.session, routes.logout];
describe("authentication and role checks (AZ-1, AZ-2)", () => {
  it("every non-public route answers 401 to an anonymous caller", async () => {
    for (const r of authedRoutes) {
      const res = await h.call(r, { body: r.method === "GET" ? undefined : r === routes.logout ? undefined : {}, params: { id: h.scenario.supplierId } });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
    }
  });
  it("a viewer gets 403 on every owner route, including reads, and nothing is changed", async () => {
    const before = await getPolicyForWeb(h.db.adminPool, h.scenario.businessId);
    for (const r of ownerRoutes) {
      const body = r === routes.policyPut ? policyBody() : r === routes.supplierPatch ? { is_approved: false } : undefined;
      const res = await h.authed(r, viewerSession, { ...(body === undefined ? {} : { body }), params: { id: h.scenario.supplierId }, headers: { "if-match": `"${String(before?.version)}"` } });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }
    expect(await getPolicyForWeb(h.db.adminPool, h.scenario.businessId)).toEqual(before);
    expect((await h.authed(routes.session, viewerSession)).status).toBe(200);
  });
  it("owner reads succeed", async () => {
    for (const r of [routes.policyGet, routes.suppliersList, routes.auditList, routes.overview]) {
      const res = await h.authed(r, ownerSession);
      expect(res.status, r.path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
  it("request ids are generated server-side and a client-supplied one is ignored", async () => {
    const res = await h.authed(routes.overview, ownerSession, { headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers.get("x-request-id")).not.toBe("attacker-chosen");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
describe("tenant isolation (AZ-3)", () => {
  it("another tenant's supplier id is 404 for GET-style lookups and PATCH, and is never modified", async () => {
    const other = await seedScenario(h.db.adminPool, { walletAddress: fakeAddress(), supplierAddress: fakeAddress(), issuer: ISSUER, currencyHex: CURRENCY_HEX });
    const before = await listSuppliersForBusiness(h.db.adminPool, other.businessId);
    const res = await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: false }, params: { id: other.supplierId } });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(await listSuppliersForBusiness(h.db.adminPool, other.businessId)).toEqual(before);
    const unknown = await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: false }, params: { id: "11111111-1111-4111-8111-111111111111" } });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ...res.body, request_id: unknown.body.request_id });
    const list = await h.authed(routes.suppliersList, ownerSession);
    expect(list.raw).not.toContain(other.supplierId);
    const audit = await h.authed(routes.auditList, ownerSession);
    expect(audit.raw).not.toContain(other.businessId);
  });
  it("the business comes from the session: a body or query that names a business is rejected", async () => {
    const policy = await getPolicyForWeb(h.db.adminPool, h.scenario.businessId);
    const withBiz = await h.authed(routes.policyPut, ownerSession, { body: { ...policyBody(), business_id: "11111111-1111-4111-8111-111111111111" }, headers: { "if-match": `"${String(policy?.version)}"` } });
    expect(withBiz.status).toBe(400);
    expect(withBiz.body.code).toBe("VALIDATION_FAILED");
    expect((await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: true, business_id: "x" }, params: { id: h.scenario.supplierId } })).status).toBe(400);
    expect((await h.authed(routes.overview, ownerSession, { query: "?business_id=11111111-1111-4111-8111-111111111111" })).status).toBe(400);
    expect((await h.authed(routes.auditList, ownerSession, { query: "?business_id=11111111-1111-4111-8111-111111111111" })).status).toBe(400);
    expect((await h.authed(routes.policyGet, ownerSession, { query: "?business_id=x" })).status).toBe(400);
  });
});
describe("request hygiene (IN-4, IN-5)", () => {
  it("rejects wrong media types, malformed JSON, oversize bodies and unknown fields", async () => {
    const policy = await getPolicyForWeb(h.db.adminPool, h.scenario.businessId);
    const headers = { "if-match": `"${String(policy?.version)}"` };
    expect((await h.authed(routes.policyPut, ownerSession, { rawBody: JSON.stringify(policyBody()), contentType: "text/plain", headers })).status).toBe(415);
    expect((await h.authed(routes.policyPut, ownerSession, { rawBody: JSON.stringify(policyBody()), contentType: null, headers })).status).toBe(415);
    expect((await h.authed(routes.policyPut, ownerSession, { rawBody: "{not json", headers })).status).toBe(400);
    expect((await h.authed(routes.policyPut, ownerSession, { rawBody: "[]", headers })).status).toBe(400);
    expect((await h.authed(routes.policyPut, ownerSession, { rawBody: JSON.stringify({ ...policyBody(), pad: "x".repeat(MAX_BODY_BYTES) }), headers })).status).toBe(413);
    expect((await h.authed(routes.policyPut, ownerSession, { body: policyBody({ max_payment_amount: 2 }), headers })).status).toBe(400);
    expect((await h.authed(routes.policyPut, ownerSession, { body: policyBody({ max_payment_amount: "1e3" }), headers })).status).toBe(400);
    expect((await h.authed(routes.policyPut, ownerSession, { body: policyBody({ version: 99 }), headers })).status).toBe(400);
    expect((await h.authed(routes.supplierPatch, ownerSession, { body: {}, params: { id: h.scenario.supplierId } })).status).toBe(400);
    expect((await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: true }, params: { id: "not-a-uuid" } })).status).toBe(400);
    expect((await h.authed(routes.auditList, ownerSession, { query: "?limit=1000" })).status).toBe(400);
    expect((await h.authed(routes.auditList, ownerSession, { query: "?limit=5&limit=6" })).status).toBe(400);
  });
  it("write routes refuse a missing or wrong Origin and a missing or foreign CSRF token", async () => {
    const policy = await getPolicyForWeb(h.db.adminPool, h.scenario.businessId);
    const headers = { "if-match": `"${String(policy?.version)}"` };
    const body = policyBody({ max_payment_amount: "1" });
    expect((await h.call(routes.policyPut, { cookie: ownerSession.cookie, body, headers })).status).toBe(403);
    expect((await h.call(routes.policyPut, { cookie: ownerSession.cookie, csrf: viewerSession.csrf, body, headers })).status).toBe(403);
    expect((await h.authed(routes.policyPut, ownerSession, { body, headers, origin: "http://evil.example" })).status).toBe(403);
    expect((await h.authed(routes.policyPut, ownerSession, { body, headers, origin: null })).status).toBe(403);
    expect((await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: false }, params: { id: h.scenario.supplierId }, csrf: "x".repeat(43) })).status).toBe(403);
    expect((await getPolicyForWeb(h.db.adminPool, h.scenario.businessId))?.version).toBe(policy?.version);
  });
  it("error bodies never contain SQL, stack traces, file paths or table names", async () => {
    const results = [
      await h.call(routes.policyGet),
      await h.authed(routes.supplierPatch, ownerSession, { body: { is_approved: true }, params: { id: "not-a-uuid" } }),
      await h.authed(routes.policyPut, ownerSession, { rawBody: "{", headers: { "if-match": '"1"' } }),
      await h.authed(routes.policyPut, ownerSession, { body: policyBody(), headers: { "if-match": '"9999"' } }),
    ];
    for (const r of results) expect(r.raw).not.toMatch(/SELECT|INSERT|UPDATE |FROM |treasury_|node_modules|\.ts:|at \S+ \(|[A-Z]:\\|stack|flow_web/i);
  });
  it("a viewer's denied write changes no rows", async () => {
    const before = await tableCounts(h.db.adminPool);
    await h.authed(routes.supplierPatch, viewerSession, { body: { is_approved: false }, params: { id: h.scenario.supplierId } });
    expect(await tableCounts(h.db.adminPool)).toEqual(before);
  });
});

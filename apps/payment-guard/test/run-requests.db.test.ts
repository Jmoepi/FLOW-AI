import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentRunRequest, withTransaction } from "@flow-ai/database";
import { auditActorsForEntity, type Scenario } from "@flow-ai/database/testing";
import { createHarness, type Harness } from "./db-harness";
import { TOKEN } from "./helpers";
let h: Harness;
let s: Scenario;
const claim = async (token: string | null = TOKEN, payload?: unknown) => {
  const res = await h.guard.app.inject({
    method: "POST",
    url: "/internal/run-requests/claim",
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  h.bodies.push(res.body);
  return res;
};
beforeAll(async () => {
  h = await createHarness();
  s = await h.scenario({ dailyLimit: "10", maxPayment: "2" });
  h.config.businessId = s.businessId;
});
afterAll(async () => {
  await h.close();
});
describe("POST /internal/run-requests/claim", () => {
  it("needs the agent bearer token", async () => {
    expect((await claim(null)).statusCode).toBe(401);
    expect((await claim("wrong-token-value-0123456789")).statusCode).toBe(401);
  });
  it("answers 204 with no body when nothing is open", async () => {
    const res = await claim();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });
  it("hands over one request id, never a business id, and audits the claim; a second claim finds nothing", async () => {
    const created = await withTransaction(h.db.adminPool, (c) => createAgentRunRequest(c, s.businessId, "00000000-0000-4000-8000-0000000000aa"));
    const res = await claim();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["request_id"]);
    expect(body.request_id).toBe(created.id);
    expect(res.body).not.toContain(s.businessId);
    expect((await claim()).statusCode).toBe(204);
    expect(await auditActorsForEntity(h.db.adminPool, created.id, "agent.run_request_claimed")).toEqual(["system"]);
  });
  it("ignores a caller-supplied business id (the guard resolves its own tenant)", async () => {
    const res = await claim(TOKEN, { business_id: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(204);
  });
});

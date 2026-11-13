import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRunRows } from "@flow-ai/database/testing";
import { GuardError, createGuardClient } from "../src/guard/client";
import { createLogger } from "../src/logger";
import { agentRun, newBusiness, spyFetch, startStack, TOKEN, type Stack } from "./helpers/real-guard";

/** The guard's DEFAULT rate limit (30 requests per minute), not the relaxed one the other harnesses use. */
let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ config: { rateLimitPerMinute: 30 } });
}, 120_000);
afterAll(async () => {
  await stack.close();
});

describe("rate limits", () => {
  it("a full run needs fewer than 20 guard requests and is never rate limited", async () => {
    const s = await newBusiness(stack, { maxPayment: "2", dailyLimit: "10" });
    await stack.h.invoice(s, { amount: "1" });
    const tool = spyFetch();
    const recorder = spyFetch();
    const result = await agentRun(stack, { toolFetch: tool.fetchImpl, recorderFetch: recorder.fetchImpl });
    expect(result.status).toBe("paid");
    const all = [...tool.seen, ...recorder.seen];
    expect(all.length).toBeLessThanOrEqual(20);
    expect(all.some((r) => r.status === 429)).toBe(false);
    expect((await agentRunRows(stack.h.db.adminPool, s.businessId))[0]?.status).toBe("paid");
  }, 60_000);

  it("a burst of 40 requests gets 429s, surfaced as RATE_LIMITED, and the client never retries", async () => {
    await newBusiness(stack, { maxPayment: "2", dailyLimit: "10" });
    const spy = spyFetch();
    const guard = createGuardClient({ baseUrl: stack.url, token: TOKEN, fetchImpl: spy.fetchImpl, logger: createLogger(() => undefined) });
    const outcomes = await Promise.allSettled(Array.from({ length: 40 }, () => guard.snapshot()));
    const limited = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof GuardError && o.reason.code === "RATE_LIMITED");
    expect(limited.length).toBeGreaterThan(0);
    expect(spy.seen.filter((r) => r.status === 429).length).toBe(limited.length);
    // One fetch per call: a 429 is never retried.
    expect(spy.seen).toHaveLength(40);
  }, 60_000);
});

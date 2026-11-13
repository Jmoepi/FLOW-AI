import { afterEach, describe, expect, it } from "vitest";
import { createGuardClient, GuardError } from "../src/guard/client";
import { createLogger } from "../src/logger";
import { createRecorder, RecorderError } from "../src/run/recorder";
import { RUN_ID, TOKEN, startFakeGuard, type FakeGuard } from "./helpers/fake-guard";

// Assembled at runtime so the secret scanner does not flag the fixture.
const FAKE_KEY = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
let fake: FakeGuard;
const logs: string[] = [];
const logger = createLogger((l) => logs.push(l));
async function rec() {
  fake = await startFakeGuard();
  return createRecorder(createGuardClient({ baseUrl: fake.url, token: TOKEN, logger }), logger);
}
afterEach(async () => {
  await fake.close();
});

describe("recorder", () => {
  it("start returns the run id; a refused create propagates and no run exists", async () => {
    const r = await rec();
    expect(await r.start("manual", "deterministic")).toBe(RUN_ID);
    await fake.close();
    const r2 = await rec();
    fake.createRunStatus = 409;
    await expect(r2.start("manual", "deterministic")).rejects.toBeInstanceOf(GuardError);
    expect(r2.runId).toBeNull();
    await expect(r2.intent({ kind: "note" })).rejects.toBeInstanceOf(RecorderError);
  });

  it("redacts secret-shaped values, truncates long strings and caps size", async () => {
    const r = await rec();
    await r.start("manual", "deterministic");
    await r.event({
      kind: "tool_call",
      tool_name: "get_business_snapshot",
      input: { api_key: FAKE_KEY, note: "x".repeat(1000), nested: { password: "hunter2" } },
      output: { big: Array.from({ length: 20 }, () => "y".repeat(300)) },
    });
    const sent = JSON.stringify(fake.events[0]);
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).not.toContain("hunter2");
    expect(sent).toContain("[REDACTED]");
    expect(sent).toContain("[truncated]");
    expect(new TextEncoder().encode(sent).length).toBeLessThan(8192);
    expect(JSON.stringify(r.events())).not.toContain("hunter2");
  });

  it("event never throws into the loop; intent fails closed", async () => {
    const r = await rec();
    await r.start("manual", "deterministic");
    fake.eventStatus = 500;
    await expect(r.event({ kind: "note" })).resolves.toBeUndefined();
    await expect(r.intent({ kind: "note" })).rejects.toBeInstanceOf(RecorderError);
  });

  it("finish retries once and never throws", async () => {
    const r = await rec();
    await r.start("manual", "deterministic");
    expect(await r.finish({ client_status: "paid", summary: "ok", tool_call_count: 5 })).toBe(true);
    expect(fake.finishes).toHaveLength(1);
    await fake.close();
    const r2 = await rec();
    expect(await r2.finish({ client_status: "failed", summary: "x", tool_call_count: 0 })).toBe(false); // not started
  });
  it("treats a 409 on the retry as already finished (a run is finished only once)", async () => {
    let calls = 0;
    const stub = {
      createRun: () => Promise.resolve({ run_id: RUN_ID, started_at: "x" }),
      finishRun: () => {
        calls += 1;
        return Promise.reject(calls === 1 ? new GuardError("GUARD_UNAVAILABLE", "down", 502) : new GuardError("GUARD_REJECTED", "conflict", 409));
      },
    } as unknown as Parameters<typeof createRecorder>[0];
    const r = createRecorder(stub, logger);
    await r.start("manual", "deterministic");
    expect(await r.finish({ client_status: "paid", summary: "ok", tool_call_count: 1 })).toBe(true);
    expect(calls).toBe(2);
  });
});

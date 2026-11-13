import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_ATTEMPT_RETENTION_MS, startHousekeeping } from "../src/server/housekeeping";
import type { WebDeps } from "../src/server/deps";
const calls: { sql: string; values: unknown[] }[] = [];
const fakeDeps = (fail = false): WebDeps =>
  ({
    pool: {
      query: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return fail ? Promise.reject(new Error("db down")) : Promise.resolve({ rows: [{ key_hash: "x", id_hash: "y" }], rowCount: 1 });
      },
    },
    now: () => new Date("2026-02-10T00:00:00.000Z"),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  }) as unknown as WebDeps;
beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
describe("housekeeping schedule", () => {
  it("waits for the first delay, then runs hourly, pruning windows older than two days", async () => {
    const getDeps = vi.fn(() => Promise.resolve(fakeDeps()));
    const job = startHousekeeping(getDeps, () => undefined, { firstDelayMs: 1000, intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(getDeps).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getDeps).toHaveBeenCalledTimes(1);
    const prune = calls.find((c) => c.sql.includes("login_attempts"));
    expect((prune?.values[0] as Date).toISOString()).toBe(new Date(Date.parse("2026-02-10T00:00:00.000Z") - LOGIN_ATTEMPT_RETENTION_MS).toISOString());
    expect(calls.some((c) => c.sql.includes("web_sessions"))).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getDeps).toHaveBeenCalledTimes(2);
    job.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getDeps).toHaveBeenCalledTimes(2);
  });
  it("logs a failure with the redacting path, never throws, and tries again on the next tick", async () => {
    const errors: string[] = [];
    const getDeps = vi.fn(() => Promise.resolve(fakeDeps(true)));
    const job = startHousekeeping(getDeps, (m) => errors.push(m), { firstDelayMs: 10, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toHaveLength(2);
    job.stop();
  });
  it("does not overlap passes", async () => {
    let release: () => void = () => undefined;
    const getDeps = vi.fn(() => new Promise<WebDeps>((resolve) => (release = () => resolve(fakeDeps()))));
    const job = startHousekeeping(getDeps, () => undefined, { firstDelayMs: 10, intervalMs: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect(getDeps).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(getDeps.mock.calls.length).toBeGreaterThanOrEqual(2);
    job.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "../src/scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("scheduler", () => {
  it("runs once per interval", async () => {
    const runOnce = vi.fn(() => Promise.resolve());
    const s = createScheduler({ intervalMinutes: 5, runOnce });
    s.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(runOnce).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("does not start a second run while one is active (overlap protection)", async () => {
    let release: () => void = () => undefined;
    const runOnce = vi.fn(() => new Promise<void>((r) => (release = r)));
    const onSkip = vi.fn();
    const s = createScheduler({ intervalMinutes: 1, runOnce, onSkip });
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(3);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    release();
    await s.stop();
  });

  it("stop waits for the active run and schedules nothing further", async () => {
    let release: () => void = () => undefined;
    const runOnce = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = createScheduler({ intervalMinutes: 1, runOnce });
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    const p = s.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await p;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("keeps ticking after a failed run and reports the error", async () => {
    const onError = vi.fn();
    const runOnce = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const s = createScheduler({ intervalMinutes: 1, runOnce, onError });
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await s.stop();
  });

  it("can fire the first tick immediately", async () => {
    const runOnce = vi.fn(() => Promise.resolve());
    const s = createScheduler({ intervalMinutes: 60, runOnce, runImmediately: true });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await s.stop();
  });
});

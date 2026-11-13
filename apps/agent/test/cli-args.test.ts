import { describe, expect, it } from "vitest";
import { CliUsageError, exitCodeFor, formatSummary, parseCliArgs } from "../src/cli";
import type { RunResult } from "../src/run/types";

describe("parseCliArgs", () => {
  it("defaults to a manual single run", () => {
    expect(parseCliArgs([])).toEqual({ trigger: "manual", probeIneligible: false, schedule: false, record: null });
  });
  it("ignores a leading -- from pnpm and parses flags", () => {
    expect(parseCliArgs(["--", "--probe-ineligible"]).probeIneligible).toBe(true);
    expect(parseCliArgs(["--trigger", "interval"]).trigger).toBe("interval");
    expect(parseCliArgs(["--schedule"])).toMatchObject({ schedule: true, trigger: "interval" });
    expect(parseCliArgs(["--record"]).record).toBe(true);
    expect(parseCliArgs(["--record", "out.json", "--probe-ineligible"])).toMatchObject({ record: "out.json", probeIneligible: true });
  });
  it.each([["--nope"], ["positional"], ["--trigger"], ["--trigger", "weekly"], ["--trigger", "manual", "--trigger", "interval"], ["--mode=llm"]])("rejects %j", (...argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
  });
});

describe("exit codes and summary", () => {
  const result = (over: Partial<RunResult>): RunResult => ({
    status: "paid",
    summary: "ok\u0000\u202E",
    runId: "r",
    mode: "deterministic",
    effectiveMode: "deterministic",
    trigger: "manual",
    toolCallCount: 5,
    candidateInvoiceId: null,
    paymentId: "p",
    txHash: "H",
    explorerUrl: "https://testnet.xrpl.org/transactions/H",
    decisionCode: "ALLOWED",
    agentReason: null,
    events: [],
    ...over,
  });
  it("maps statuses", () => {
    for (const s of ["paid", "pending", "blocked", "no_candidate"] as const) expect(exitCodeFor(s)).toBe(0);
    for (const s of ["failed", "timed_out", "limit_exceeded", "interrupted"] as const) expect(exitCodeFor(s)).toBe(1);
    expect(exitCodeFor("skipped")).toBe(3);
  });
  it("prints one sanitised line with the evidence", () => {
    const line = formatSummary(result({}));
    expect(line).toContain("status=paid");
    expect(line).toContain("tx=H");
    expect(line).toContain("explorer=https://testnet.xrpl.org/transactions/H");
    expect(Array.from(line).some((c) => c.charCodeAt(0) < 32 || c === "\u202e")).toBe(false);
  });
});

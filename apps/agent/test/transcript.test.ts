import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptError, resolveInside, writeTranscript } from "../src/run/transcript";
import type { RunResult } from "../src/run/types";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "transcript-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const run = (over: Partial<RunResult> = {}): RunResult => ({
  status: "blocked",
  summary: "Blocked by the guard.",
  runId: "11111111-1111-4111-8111-111111111111",
  mode: "deterministic",
  effectiveMode: "deterministic",
  trigger: "manual",
  toolCallCount: 4,
  candidateInvoiceId: null,
  paymentId: null,
  txHash: null,
  explorerUrl: null,
  decisionCode: "PAYMENT_LIMIT_EXCEEDED",
  agentReason: "Deterministic rule: earliest due date.",
  events: [{ kind: "tool_call", tool_name: "get_business_snapshot", ok: true, output: { count: 1 } }],
  ...over,
});

describe("writeTranscript", () => {
  it("writes a labelled secret-free file with a generated name", () => {
    const dir = tmp();
    const file = writeTranscript(dir, run(), "testnet", { now: new Date("2026-01-02T03:04:05.678Z") });
    expect(path.basename(file)).toBe("agent-run-20260102T030405Z-blocked.json");
    const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(body).toMatchObject({ schema_version: 1, label: "RECORDED RUN (not live)", ledger: "testnet", status: "blocked", payment: null });
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it("refuses a planted secret", () => {
    const dir = tmp();
    const seed = `s${"E".repeat(28)}`;
    expect(() => writeTranscript(dir, run({ summary: `leak XRPL_DEMO_SIGNER_SEED=${seed}` }), "testnet")).toThrow(TranscriptError);
    expect(readdirSync(dir)).toHaveLength(0);
  });
  it("refuses a fake-ledger transcript unless explicitly allowed", () => {
    expect(() => writeTranscript(tmp(), run(), "fake")).toThrow(TranscriptError);
    expect(() => writeTranscript(tmp(), run(), "fake", { allowFakeLedger: true })).not.toThrow();
  });
  it("rejects a path outside the directory", () => {
    const dir = tmp();
    expect(() => resolveInside(dir, path.join("..", "evil.json"))).toThrow(TranscriptError);
    expect(resolveInside(dir, "ok.json")).toBe(path.join(dir, "ok.json"));
  });
});

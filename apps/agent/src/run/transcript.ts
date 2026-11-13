import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactValue, sanitizeText, scanText } from "@flow-ai/contracts";
import type { RunResult } from "./types";

export type TranscriptLedger = "testnet" | "fake";

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
  }
}

/** Secret-free, labelled record of one run (spec 14.5 fallback). Built only from the already redacted run result. */
export interface Transcript {
  schema_version: 1;
  label: "RECORDED RUN (not live)";
  recorded_at: string;
  ledger: TranscriptLedger;
  network: "xrpl-testnet";
  mode: string;
  effective_mode: string;
  trigger: string;
  status: string;
  summary: string;
  decision_code: string | null;
  agent_reason: string | null;
  tool_call_count: number;
  payment: { id: string; tx_hash: string | null; explorer_url: string | null } | null;
  events: unknown[];
}

export function buildTranscript(run: RunResult, ledger: TranscriptLedger, now: Date = new Date()): Transcript {
  return {
    schema_version: 1,
    label: "RECORDED RUN (not live)",
    recorded_at: now.toISOString(),
    ledger,
    network: "xrpl-testnet",
    mode: run.mode,
    effective_mode: run.effectiveMode,
    trigger: run.trigger,
    status: run.status,
    summary: sanitizeText(run.summary, 500),
    decision_code: run.decisionCode,
    agent_reason: run.agentReason === null ? null : sanitizeText(run.agentReason, 280),
    tool_call_count: run.toolCallCount,
    payment: run.paymentId === null ? null : { id: run.paymentId, tx_hash: run.txHash, explorer_url: run.explorerUrl },
    events: redactValue(run.events) as unknown[],
  };
}

/** Resolves `file` and requires it to sit inside `dir` (IN-6). */
export function resolveInside(dir: string, file: string): string {
  const base = path.resolve(dir);
  const target = path.resolve(base, file);
  if (target !== base && !target.startsWith(base + path.sep)) throw new TranscriptError("Transcript path must be inside the demo directory.");
  return target;
}

/** Generated name: agent-run-<UTC>-<status>.json (no user input in the file name). */
export function transcriptName(t: Transcript): string {
  const stamp = t.recorded_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `agent-run-${stamp}-${t.status.replace(/[^a-z_]/g, "")}.json`;
}

/**
 * Writes the transcript inside `demoDir`. Refuses to write if the secret scanner finds anything, if a fake-ledger
 * transcript targets docs/demo (callers pass a temp dir for those), or if the path escapes the directory.
 * Returns the written path.
 */
export function writeTranscript(demoDir: string, run: RunResult, ledger: TranscriptLedger, opts: { now?: Date; allowFakeLedger?: boolean } = {}): string {
  if (ledger === "fake" && opts.allowFakeLedger !== true) throw new TranscriptError("Fake-ledger transcripts are test-only and must not be written to docs/demo.");
  const t = buildTranscript(run, ledger, opts.now);
  const text = `${JSON.stringify(t, null, 2)}\n`;
  const findings = scanText(text);
  if (findings.length > 0) throw new TranscriptError(`Refusing to write the transcript: ${String(findings.length)} secret finding(s).`);
  const target = resolveInside(demoDir, transcriptName(t));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, { flag: "wx" });
  return target;
}

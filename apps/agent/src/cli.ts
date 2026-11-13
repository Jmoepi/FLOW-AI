import { AgentTriggerSchema, sanitizeText, type AgentTrigger } from "@flow-ai/contracts";
import type { RunResult } from "./run/types";

export const USAGE = "Usage: agent [--trigger manual|interval] [--probe-ineligible] [--schedule] [--record [path]]";

export interface CliArgs {
  trigger: AgentTrigger;
  probeIneligible: boolean;
  schedule: boolean;
  /** `true` for a bare --record, a string for --record <path>, null when absent. */
  record: string | true | null;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = "CliUsageError";
  }
}

/** Strict: an unknown flag, a duplicate or a stray positional argument is an error. A leading `--` (from pnpm) is ignored. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const out: CliArgs = { trigger: "manual", probeIneligible: false, schedule: false, record: null };
  let triggerSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    switch (a) {
      case "--probe-ineligible":
        out.probeIneligible = true;
        break;
      case "--schedule":
        out.schedule = true;
        break;
      case "--trigger": {
        const v = AgentTriggerSchema.safeParse(args[++i]);
        if (!v.success || triggerSet) throw new CliUsageError("--trigger must be given once, as manual or interval.");
        out.trigger = v.data;
        triggerSet = true;
        break;
      }
      case "--record": {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.record = next;
          i++;
        } else out.record = true;
        break;
      }
      default:
        throw new CliUsageError("Unknown argument.");
    }
  }
  if (out.schedule && !triggerSet) out.trigger = "interval";
  return out;
}

/** 0 = the run reached a normal end (paid, pending, blocked, nothing to pay), 1 = failure, 3 = skipped (overlap). 2 is config, handled by the caller. */
export function exitCodeFor(status: RunResult["status"]): 0 | 1 | 3 {
  switch (status) {
    case "paid":
    case "pending":
    case "blocked":
    case "no_candidate":
      return 0;
    case "skipped":
      return 3;
    default:
      return 1;
  }
}

/** One secret-free line: status, payment id, hash, explorer link. Summary text is sanitised. */
export function formatSummary(r: RunResult): string {
  const parts = [`status=${r.status}`, `mode=${r.effectiveMode}`, `tool_calls=${String(r.toolCallCount)}`];
  if (r.runId !== null) parts.push(`run=${r.runId}`);
  if (r.decisionCode !== null) parts.push(`decision=${r.decisionCode}`);
  if (r.paymentId !== null) parts.push(`payment=${r.paymentId}`);
  if (r.txHash !== null) parts.push(`tx=${r.txHash}`);
  if (r.explorerUrl !== null) parts.push(`explorer=${r.explorerUrl}`);
  parts.push(`summary="${sanitizeText(r.summary, 300)}"`);
  return parts.join(" ");
}

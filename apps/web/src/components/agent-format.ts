import type { Tone } from "./Badge";
import type { AgentEventData, AgentRunData } from "./types";
/** Pure display helpers for the agent activity page. Everything returned is plain text. */
const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "ok" },
  blocked: { label: "Blocked by policy", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  no_candidate: { label: "No eligible invoice", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  timed_out: { label: "Timed out", tone: "bad" },
  limit_exceeded: { label: "Stopped at a limit", tone: "warn" },
  interrupted: { label: "Interrupted", tone: "bad" },
  running: { label: "Running", tone: "neutral" },
};
export function outcomeOf(status: string): { label: string; tone: Tone } {
  return OUTCOME[status] ?? { label: "Unknown", tone: "neutral" };
}
/**
 * The outcome to show. The guard derives `status` from its own records; as defence in depth a run is only ever shown as
 * paid when its linked payment is validated. What the agent claimed is never part of this value.
 */
export function displayStatus(run: Pick<AgentRunData, "status" | "payment">): string {
  return run.status === "paid" && run.payment?.status !== "validated" ? "failed" : run.status;
}
export function modeLabel(run: Pick<AgentRunData, "mode" | "effective_mode">): string {
  const name = (m: string): string => (m === "llm" ? "AI model" : m === "deterministic" ? "deterministic rule" : "unknown mode");
  return run.effective_mode !== null && run.effective_mode !== run.mode ? `${name(run.mode)}, fell back to ${name(run.effective_mode)}` : name(run.effective_mode ?? run.mode);
}
export const triggerLabel = (t: string): string => (t === "interval" ? "Scheduled" : t === "manual" ? "Started manually" : "Unknown trigger");
export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
const TOOL: Record<string, string> = {
  get_business_snapshot: "Checked the treasury snapshot",
  list_open_invoices: "Listed open invoices",
  get_invoice_details: "Read invoice details",
  request_supplier_payment: "Asked the payment service to pay an invoice",
  get_payment_status: "Checked the payment status",
};
/** One templated line per structured event (spec 11.8). Free text never enters these lines. */
export function describeEvent(e: AgentEventData): string {
  const code = e.error_code !== null && /^[A-Z_]{1,64}$/.test(e.error_code) ? e.error_code : null;
  if (e.kind === "tool_call") {
    const base = (e.tool_name !== null ? TOOL[e.tool_name] : undefined) ?? "Called a tool";
    return e.ok === false ? `${base}: failed${code === null ? "" : ` (${code})`}` : base;
  }
  if (e.kind === "decision") return code === null ? "Payment service returned a decision" : `Payment service decision: ${code}`;
  if (e.kind === "mode_fallback") return "AI model unavailable, used the deterministic rule instead";
  if (e.kind === "model_turn") return "AI model took a turn";
  return "Note";
}
/** Outcome sentence; blocked runs say plainly that nothing moved. */
export function outcomeText(run: AgentRunData): string {
  switch (displayStatus(run)) {
    case "paid":
      return "Payment submitted and validated on the ledger.";
    case "blocked":
      return `Payment not submitted${run.decision_code !== null && /^[A-Z_]{1,64}$/.test(run.decision_code) ? ` (${run.decision_code})` : ""}. The payment service applied your rules. No funds were moved.`;
    case "pending":
      return "Payment accepted and not yet confirmed on the ledger.";
    case "no_candidate":
      return "No open invoice was eligible, so no payment was requested.";
    case "running":
      return "This run has not finished.";
    default:
      return "The run did not complete. No payment was confirmed.";
  }
}

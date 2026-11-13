import { createHash } from "node:crypto";
import { AGENT_REASON_MAX_CHARS, MONEY_STRING_PATTERN, sanitizeText, type GuardInvoiceView } from "@flow-ai/contracts";

/** Money strings are canonical decimals with at most 6 fractional digits (contracts/money.ts). Scale to integer micro-units. */
export function toMicro(amount: string): bigint {
  const m = MONEY_STRING_PATTERN.exec(amount);
  if (!m) throw new Error("not a canonical money string");
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? ".").slice(1).padEnd(6, "0"));
}

export function compareAmounts(a: string, b: string): number {
  const x = toMicro(a);
  const y = toMicro(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Total order: due date, then amount (exact), then invoice number, then id. */
export function compareInvoices(a: GuardInvoiceView, b: GuardInvoiceView): number {
  return cmpStr(a.due_date, b.due_date) || compareAmounts(a.amount, b.amount) || cmpStr(a.invoice_number, b.invoice_number) || cmpStr(a.invoice_id, b.invoice_id);
}

export interface Choice {
  invoice: GuardInvoiceView;
  /** Number of eligible candidates (or ineligible ones when probing). */
  candidateCount: number;
  probing: boolean;
}

/**
 * Deterministic rule (spec 7.2.C): among open invoices whose read-only preview is eligible, take the earliest due date,
 * then the smallest amount. Returns null when nothing is eligible, unless `probeIneligible` is set: then the earliest-due
 * ineligible invoice is returned so the guard visibly blocks it (demo only). Free text is never consulted.
 */
export function chooseCandidate(invoices: readonly GuardInvoiceView[], opts: { probeIneligible: boolean }): Choice | null {
  const open = invoices.filter((i) => i.status === "open");
  const eligible = open.filter((i) => i.eligibility.eligible).sort(compareInvoices);
  const first = eligible[0];
  if (first !== undefined) return { invoice: first, candidateCount: eligible.length, probing: false };
  if (!opts.probeIneligible) return null;
  const ineligible = open.filter((i) => !i.eligibility.eligible).sort(compareInvoices);
  const probe = ineligible[0];
  return probe === undefined ? null : { invoice: probe, candidateCount: ineligible.length, probing: true };
}

/** Templated, no untrusted text: only a date, a count and an amount. Always at most 280 characters. */
export function buildReason(choice: Choice, maxChars: number = AGENT_REASON_MAX_CHARS): string {
  const { invoice, candidateCount, probing } = choice;
  const text = probing
    ? `Deterministic probe: earliest due date (${invoice.due_date}) among ${String(candidateCount)} ineligible invoices, amount ${invoice.amount} RLUSD. The payment guard decides.`
    : `Deterministic rule: earliest due date (${invoice.due_date}) among ${String(candidateCount)} eligible invoices, amount ${invoice.amount} RLUSD. The payment guard decides.`;
  return sanitizeText(text, Math.min(maxChars, AGENT_REASON_MAX_CHARS));
}

/** `agent-` + 40 hex of sha256("<run_id>|<invoice_id>"): stable per (run, invoice), matches the guard key regex. */
export function idempotencyKeyFor(runId: string, invoiceId: string): string {
  return `agent-${createHash("sha256").update(`${runId}|${invoiceId}`).digest("hex").slice(0, 40)}`;
}

import {
  InvoiceDetailsOutputSchema,
  ListOpenInvoicesOutputSchema,
  PaymentResultSchema,
  PaymentStatusOutputSchema,
  sanitizeText,
  type GuardInvoiceView,
  type InvoiceItem,
  type PaymentResult,
} from "@flow-ai/contracts";
import type { ToolCallResult } from "../mcp/mcp-client";
import { buildReason, chooseCandidate, idempotencyKeyFor } from "./choose";
import type { Brain, BrainContext, BrainOutcome } from "./types";

const PAY_RETRY_NOTE = "Payment outcome unknown. Do not retry; check the payment status.";

/** Tool output wraps free text as untrusted; the chooser only needs the structured fields, so text is carried through untouched. */
function toView(i: InvoiceItem): GuardInvoiceView {
  return {
    invoice_id: i.invoice_id,
    invoice_number: i.invoice_number.text,
    due_date: i.due_date,
    amount: i.amount,
    currency: i.currency,
    status: i.status,
    supplier: { name: i.supplier.name.text, country_code: i.supplier.country_code, approved: i.supplier.approved },
    description: i.description === null ? null : i.description.text,
    eligibility: i.eligibility,
  };
}

function failed(res: ToolCallResult, what: string): BrainOutcome {
  const code = res.error?.code ?? "INTERNAL";
  if (code === "RUN_TIMEOUT") return { status: "timed_out", summary: `The run ran out of time while ${what}.` };
  if (code === "TOOL_CALL_LIMIT" || code === "PAYMENT_LIMIT_PER_RUN") return { status: "limit_exceeded", summary: `A run limit stopped the agent while ${what}.` };
  return { status: "failed", summary: `The agent stopped while ${what} (${code}). No payment was requested.` };
}

/** "Payment not submitted. <guard message>. No funds were moved." The guard message is already safe; it is sanitised again here. */
function blockedSummary(p: PaymentResult): string {
  const raw = p.message === null ? (p.failure_code ?? p.decision_code ?? "blocked by the payment guard") : p.message.text;
  const msg = sanitizeText(raw, 300).trim().replace(/[.\s]+$/, "");
  return `Payment not submitted. ${msg === "" ? "Blocked by the payment guard" : msg}. No funds were moved.`;
}

export function outcomeFor(p: PaymentResult, candidateInvoiceId: string, agentReason: string): BrainOutcome {
  const common = {
    candidateInvoiceId,
    agentReason,
    ...(p.payment_id === null ? {} : { paymentId: p.payment_id }),
    ...(p.tx_hash === null ? {} : { txHash: p.tx_hash }),
    ...(p.explorer_url === null ? {} : { explorerUrl: p.explorer_url }),
    ...(p.decision_code === null ? {} : { decisionCode: p.decision_code }),
  };
  switch (p.status) {
    case "validated":
      return { ...common, status: "paid", summary: `Paid ${p.amount === null ? "the invoice" : `${p.amount} RLUSD`}. The transaction was validated on the XRPL Testnet ledger.` };
    case "blocked":
      return { ...common, status: "blocked", summary: blockedSummary(p) };
    case "failed":
    case "cancelled":
      return { ...common, status: "failed", summary: `The payment did not complete (${p.failure_code ?? p.status}). Check the payment status before retrying.` };
    default:
      return { ...common, status: "pending", summary: `Payment ${p.status.replace(/_/g, " ")}. Awaiting ledger confirmation; read the payment status later.` };
  }
}

/**
 * Deterministic brain (no model). At most five tool calls: snapshot, list, details, payment, status.
 * The rule and the reason text come from choose.ts; nothing here reads free text from business data.
 */
export function createDeterministicBrain(): Brain {
  return {
    mode: "deterministic",
    async run(ctx: BrainContext): Promise<BrainOutcome> {
      const snap = await ctx.callTool("get_business_snapshot", {});
      if (!snap.ok) return failed(snap, "reading the business snapshot");

      const listRes = await ctx.callTool("list_open_invoices", { limit: 20 });
      if (!listRes.ok) return failed(listRes, "listing open invoices");
      const list = ListOpenInvoicesOutputSchema.safeParse(listRes.data);
      if (!list.success) return { status: "failed", summary: "The invoice list had an unexpected shape. No payment was requested." };

      const choice = chooseCandidate(list.data.invoices.map(toView), { probeIneligible: ctx.probeIneligible });
      if (choice === null) return { status: "no_candidate", summary: "No open invoice is eligible for payment right now. No payment was requested." };
      const invoiceId = choice.invoice.invoice_id;

      const detailsRes = await ctx.callTool("get_invoice_details", { invoice_id: invoiceId });
      if (!detailsRes.ok) return { ...failed(detailsRes, "re-reading the chosen invoice"), candidateInvoiceId: invoiceId };
      const details = InvoiceDetailsOutputSchema.safeParse(detailsRes.data);
      if (!details.success) return { status: "failed", summary: "The invoice details had an unexpected shape. No payment was requested.", candidateInvoiceId: invoiceId };
      if (!details.data.invoice.eligibility.eligible && !choice.probing) {
        return { status: "no_candidate", summary: "The chosen invoice is no longer eligible. No payment was requested.", candidateInvoiceId: invoiceId };
      }

      const reason = buildReason(choice, ctx.config.reasonMaxChars);
      const key = idempotencyKeyFor(ctx.runId, invoiceId);
      // Fail closed: if the intent cannot be recorded, the payment is not requested (RecorderError propagates to runAgent).
      await ctx.recorder.intent({ kind: "tool_call", tool_name: "request_supplier_payment", input: { invoice_id: invoiceId, idempotency_key: key, agent_reason: reason } });

      const payRes = await ctx.callTool("request_supplier_payment", { invoice_id: invoiceId, idempotency_key: key, agent_reason: reason });
      if (!payRes.ok) {
        const code = payRes.error?.code;
        if (code === "GUARD_TIMEOUT" || code === "RUN_TIMEOUT") return { status: "timed_out", summary: PAY_RETRY_NOTE, candidateInvoiceId: invoiceId, agentReason: reason };
        if (code === "TOOL_CALL_LIMIT" || code === "PAYMENT_LIMIT_PER_RUN") return { ...failed(payRes, "requesting payment"), candidateInvoiceId: invoiceId, agentReason: reason };
        return { status: "failed", summary: `The payment request did not complete (${code ?? "INTERNAL"}). Check the payment status before retrying.`, candidateInvoiceId: invoiceId, agentReason: reason };
      }
      const pay = PaymentResultSchema.safeParse(payRes.data);
      if (!pay.success) return { status: "failed", summary: "The payment response had an unexpected shape. Check the payment status.", candidateInvoiceId: invoiceId, agentReason: reason };

      let result = pay.data;
      // A blocked decision is final: no retry, no status poll. Otherwise read the status exactly once.
      if (result.status !== "blocked" && result.payment_id !== null) {
        const st = await ctx.callTool("get_payment_status", { payment_id: result.payment_id });
        if (st.ok) {
          const parsed = PaymentStatusOutputSchema.safeParse(st.data);
          const latest = parsed.success ? parsed.data.payments[0] : undefined;
          if (latest !== undefined && latest.payment_id === result.payment_id) {
            result = { ...latest, decision_code: latest.decision_code ?? result.decision_code, policy_version: latest.policy_version ?? result.policy_version };
          }
        }
      }
      return outcomeFor(result, invoiceId, reason);
    },
  };
}

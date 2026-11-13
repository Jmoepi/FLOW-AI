import type { Tone } from "./Badge";
/**
 * One shared status vocabulary (spec 11.9). Each status has a label, a tone, a distinct icon shape and a plain
 * definition, so colour is never the only cue. "Paid" is used only for a validated payment or a paid invoice.
 */
export type IconKey = "check" | "warn" | "cross" | "pause" | "clock" | "arrow" | "ban" | "lock" | "dot" | "doc";
export interface StatusInfo {
  label: string;
  tone: Tone;
  icon: IconKey;
  definition: string;
}
const UNKNOWN: StatusInfo = { label: "Unknown", tone: "neutral", icon: "dot", definition: "The status is not recognised. Nothing is assumed to have been paid." };
const PAYMENT: Record<string, StatusInfo> = {
  requested: { label: "Requested", tone: "neutral", icon: "doc", definition: "The payment was requested and is being checked." },
  reserved: { label: "Reserved", tone: "neutral", icon: "lock", definition: "The amount is set aside from today's allowance. It has not been sent." },
  submitted: { label: "Submitted", tone: "neutral", icon: "arrow", definition: "Sent to the ledger and waiting for confirmation. Not paid yet." },
  pending_confirmation: { label: "Pending confirmation", tone: "warn", icon: "clock", definition: "The ledger has not confirmed this payment yet. It is not counted as paid." },
  validated: { label: "Paid", tone: "ok", icon: "check", definition: "Confirmed by the ledger. The supplier has received the payment." },
  blocked: { label: "Blocked by policy", tone: "warn", icon: "warn", definition: "Your rules stopped this payment. No funds were moved." },
  failed: { label: "Failed", tone: "bad", icon: "cross", definition: "The payment did not complete. No payment is counted as paid." },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "ban", definition: "The request was cancelled before it was sent. No funds were moved." },
};
const INVOICE: Record<string, StatusInfo> = {
  draft: { label: "Draft", tone: "neutral", icon: "doc", definition: "Not ready to pay yet." },
  open: { label: "Open", tone: "neutral", icon: "dot", definition: "Waiting to be paid." },
  processing: { label: "Processing", tone: "neutral", icon: "clock", definition: "A payment is in progress for this invoice." },
  paid: { label: "Paid", tone: "ok", icon: "check", definition: "A payment for this invoice was confirmed by the ledger." },
  blocked: { label: "Blocked by policy", tone: "warn", icon: "warn", definition: "Your rules stopped the latest payment attempt. Review it below." },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "ban", definition: "This invoice will not be paid." },
};
export const PAYMENT_STATUSES: readonly string[] = Object.keys(PAYMENT);
export const INVOICE_STATUSES: readonly string[] = Object.keys(INVOICE);
export const paymentStatus = (status: string): StatusInfo => (Object.hasOwn(PAYMENT, status) ? (PAYMENT[status] ?? UNKNOWN) : UNKNOWN);
export const invoiceStatus = (status: string): StatusInfo => (Object.hasOwn(INVOICE, status) ? (INVOICE[status] ?? UNKNOWN) : UNKNOWN);

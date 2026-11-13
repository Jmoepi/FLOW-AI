import type { PaymentStatus } from "@flow-ai/contracts";
import type { InvoiceStatus } from "@flow-ai/database";
/**
 * Legal payment transitions. This table MIRRORS payments_guard_transition() in migration 0003; a unit test compares
 * the two exhaustively so they cannot drift. Terminal statuses accept no update at all.
 */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = ["requested", "blocked", "reserved", "submitted", "pending_confirmation", "validated", "failed", "cancelled"];
export const TERMINAL_STATUSES: readonly PaymentStatus[] = ["blocked", "validated", "failed", "cancelled"];
const LEGAL: ReadonlySet<string> = new Set([
  "requested>blocked",
  "requested>reserved",
  "requested>cancelled",
  "reserved>submitted",
  "reserved>cancelled",
  "submitted>validated",
  "submitted>failed",
  "submitted>pending_confirmation",
  "pending_confirmation>validated",
  "pending_confirmation>failed",
]);
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL.has(`${from}>${to}`);
}
export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
/** In flight = the HTTP caller gets 202 and must poll (reserved/submitted/pending). */
export function isInFlight(status: PaymentStatus): boolean {
  return !isTerminal(status);
}
/** Invoice status derived from the latest payment attempt (spec 5A.1). One helper for every transition. */
export function invoiceStatusFor(payment: PaymentStatus): InvoiceStatus {
  switch (payment) {
    case "requested":
    case "reserved":
    case "submitted":
    case "pending_confirmation":
      return "processing";
    case "validated":
      return "paid";
    case "blocked":
      return "blocked";
    case "failed":
    case "cancelled":
      return "open";
  }
}

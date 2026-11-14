import type { DecisionCode } from "@flow-ai/contracts";
/**
 * Plain-language explanation of every decision code the payment service can return (spec 9.3 plus the M2 additions).
 * Fixed strings only: nothing from a request or a record is interpolated, so nothing here can carry markup or a secret.
 */
export interface DecisionExplanation {
  title: string;
  plain: string;
  whatToDo: string;
}
const TABLE: Record<DecisionCode, DecisionExplanation> = {
  AUTOMATION_PAUSED: { title: "Automation is paused", plain: "You paused automation, so the payment service approves nothing.", whatToDo: "Turn automation back on in Payment policies when you are ready." },
  EXECUTION_DISABLED: { title: "Emergency stop is on", plain: "Payment execution is switched off on the server. No payment can be sent.", whatToDo: "Only the operator can lift the emergency stop. Contact your operator." },
  MANDATE_EXPIRED: { title: "Policy has expired", plain: "The validity date of your payment policy has passed.", whatToDo: "Set a new validity date in Payment policies." },
  INVOICE_NOT_FOUND: { title: "Invoice not found", plain: "The payment service could not find this invoice for your business.", whatToDo: "Check the invoice list. Nothing was paid." },
  INVOICE_NOT_PAYABLE: { title: "Invoice cannot be paid", plain: "The invoice is not open for payment, for example it is already paid or cancelled.", whatToDo: "Review the invoice status. No action is needed if it is already paid." },
  SUPPLIER_NOT_APPROVED: { title: "Supplier not approved", plain: "Only suppliers you approved can be paid, and this one is not approved.", whatToDo: "Review the supplier and approve it in Suppliers if you trust it." },
  INVALID_DESTINATION: { title: "Destination address is not valid", plain: "The supplier address on file is not a valid payment address.", whatToDo: "Check the supplier record. Nothing was paid." },
  ASSET_NOT_ALLOWED: { title: "Asset not allowed", plain: "The invoice currency is not in your list of allowed assets.", whatToDo: "Review the allowed assets in Payment policies." },
  PAYMENT_LIMIT_EXCEEDED: { title: "Over the per-payment limit", plain: "The invoice amount is higher than the largest single payment you allow.", whatToDo: "Raise the per-payment limit in Payment policies, or pay this invoice yourself." },
  DAILY_LIMIT_EXCEEDED: { title: "Over today's limit", plain: "Paying this invoice would pass the daily spending limit you set.", whatToDo: "Wait for tomorrow, or raise the daily limit in Payment policies." },
  MINIMUM_RESERVE_BREACHED: { title: "Would dip below the minimum reserve", plain: "Paying this invoice would leave the treasury below the reserve you want to keep.", whatToDo: "Top up the treasury or lower the minimum reserve in Payment policies." },
  INSUFFICIENT_RLUSD_BALANCE: { title: "Not enough RLUSD", plain: "The treasury does not hold enough RLUSD for this payment.", whatToDo: "Add RLUSD to the treasury wallet." },
  MISSING_RLUSD_TRUSTLINE: { title: "Supplier cannot receive RLUSD yet", plain: "The supplier account has not opted in to hold RLUSD on the ledger.", whatToDo: "Ask the supplier to set up the RLUSD trust line." },
  XRPL_RESERVE_INSUFFICIENT: { title: "Ledger account reserve too low", plain: "The ledger requires a small amount of XRP to be held back, and an account is below it.", whatToDo: "Add a little test XRP to the treasury account." },
  DUPLICATE_REQUEST: { title: "Duplicate request", plain: "The same payment request was already received, so it was not repeated.", whatToDo: "No action needed. Check the payment list for the first request." },
  PAYMENT_ALREADY_IN_PROGRESS: { title: "Payment already in progress", plain: "This invoice already has a payment that is being processed or is paid.", whatToDo: "Wait for it to finish. Nothing was sent twice." },
  NETWORK_NOT_ALLOWED: { title: "Network not allowed", plain: "Only the XRPL Testnet is allowed in this demo.", whatToDo: "No action is possible from the dashboard." },
  XRPL_SUBMISSION_FAILED: { title: "The ledger did not accept the payment", plain: "The payment was approved by your rules but the ledger rejected or lost it.", whatToDo: "Check the payment detail. You may retry from the agent." },
  SIGNING_KEY_REVOKED: { title: "Guard signing key revoked", plain: "The ledger refused the guard's signing key, so this payment was not sent and no money moved. Payments are paused.", whatToDo: "Register a new guard key with the owner script (pnpm owner:set-regular-key). Then the guard resumes on its own." },
  PARTIAL_DELIVERY: { title: "Partly delivered", plain: "The ledger delivered less than the invoice amount.", whatToDo: "Review the payment detail and contact the supplier." },
  VALIDATION_PENDING: { title: "Waiting for the ledger", plain: "The payment was sent and is waiting for the ledger to confirm it.", whatToDo: "No action needed. It is only shown as paid once confirmed." },
  INVALID_REQUEST: { title: "Request not valid", plain: "The payment service could not read the request, so it did nothing.", whatToDo: "No action needed. Nothing was paid." },
  INVALID_AMOUNT: { title: "Amount not valid", plain: "The amount on the request was not a valid payment amount.", whatToDo: "Check the invoice amount. Nothing was paid." },
  SUPPLIER_INACTIVE: { title: "Supplier is inactive", plain: "This supplier is switched off, so it cannot be paid.", whatToDo: "Reactivate the supplier in Suppliers if this is a mistake." },
  RECORD_INACTIVE: { title: "A required record is inactive", plain: "The business or treasury wallet record is not active.", whatToDo: "Contact your operator. Nothing was paid." },
  RECORD_MISMATCH: { title: "Records do not match", plain: "The invoice, supplier and treasury records do not belong together.", whatToDo: "Contact your operator. Nothing was paid." },
  REQUEST_MISMATCH: { title: "Request differs from the stored invoice", plain: "The request did not match the invoice on file, so the stored record was used and the request was refused.", whatToDo: "No action needed. The payment service trusts stored records only." },
  BALANCE_UNAVAILABLE: { title: "Balance could not be checked", plain: "The payment service could not read a fresh balance, so it refused to pay.", whatToDo: "Try again shortly. Nothing was paid." },
  INTERNAL_ERROR: { title: "Payment service error", plain: "The payment service hit an internal problem and stopped safely.", whatToDo: "Try again later. Nothing was paid." },
};
const GENERIC: DecisionExplanation = {
  title: "Blocked by the payment service",
  plain: "The payment service blocked this request. No funds were moved.",
  whatToDo: "Review your payment policies and the supplier.",
};
const SHAPE = /^[A-Z_]{1,64}$/;
/** Never throws. Unknown or malformed input maps to the generic line. */
export function explainDecision(code: string | null | undefined): DecisionExplanation {
  if (typeof code !== "string" || !SHAPE.test(code)) return GENERIC;
  return Object.hasOwn(TABLE, code) ? (TABLE as Record<string, DecisionExplanation>)[code] ?? GENERIC : GENERIC;
}
export const DECISION_TABLE_CODES: readonly string[] = Object.keys(TABLE);

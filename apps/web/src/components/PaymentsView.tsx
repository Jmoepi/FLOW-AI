import type { ReactNode } from "react";
import { Pager, StatusFilter } from "./InvoicesView";
import { EmptyState } from "./States";
import { PaymentTable } from "./Tables";
import { PAYMENT_STATUSES, paymentStatus } from "./status-vocab";
import type { PaymentsPage } from "./types";
export function PaymentsView({ page, status, timezone }: { page: PaymentsPage; status: string | null; timezone: string }): ReactNode {
  return (
    <>
      <h1>Payments</h1>
      <p className="lede">Every payment the payment service handled. A payment is Paid only after the XRPL Testnet ledger confirms it.</p>
      <StatusFilter action="/payments" statuses={PAYMENT_STATUSES} label={(s) => paymentStatus(s).label} current={status} define="" />
      {page.payments.length === 0 ? (
        <EmptyState title={status === null ? "No payments yet" : "No payments with this status"}>{status === null ? "Payments appear here after the agent requests one." : "Choose another status or clear the filter."}</EmptyState>
      ) : (
        <PaymentTable payments={page.payments} timezone={timezone} caption={`Payments, page ${String(page.page)}`} />
      )}
      <Pager base="/payments" status={status} page={page.page} hasMore={page.has_more} />
    </>
  );
}

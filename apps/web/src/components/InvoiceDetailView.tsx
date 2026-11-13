import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { BlockedNotice } from "./States";
import { InvoiceStatus } from "./Tables";
import { groupMoney, shortAddress } from "./format";
import { dueInfo } from "./invoice-format";
import { invoiceStatus } from "./status-vocab";
import type { InvoiceData } from "./types";
export function InvoiceDetailView({ invoice, today }: { invoice: InvoiceData; today: string }): ReactNode {
  const due = dueInfo(invoice.due_date, today);
  return (
    <>
      <p>
        <a href="/invoices">All invoices</a>
      </p>
      <h1>Invoice {invoice.invoice_number}</h1>
      <p>
        <InvoiceStatus status={invoice.status} /> <span>{invoiceStatus(invoice.status).definition}</span>
      </p>
      {invoice.blocked_code === null ? null : <BlockedNotice code={invoice.blocked_code} />}
      <dl className="detail-list">
        <dt>Supplier</dt>
        <dd>
          <a href="/suppliers">{invoice.supplier_name}</a>
        </dd>
        <dt>Route</dt>
        <dd>
          {invoice.corridor}
          {invoice.supplier_country === undefined ? "" : `, supplier country ${invoice.supplier_country}`}
        </dd>
        <dt>Destination address</dt>
        <dd>
          {invoice.supplier_address === undefined ? (
            "Not available"
          ) : (
            <>
              <span className="address">{shortAddress(invoice.supplier_address)}</span> <CopyButton value={invoice.supplier_address} label="Destination address" />
            </>
          )}
        </dd>
        <dt>Amount</dt>
        <dd>
          {groupMoney(invoice.amount)} {invoice.currency} (test funds)
        </dd>
        <dt>Issued</dt>
        <dd>{invoice.issue_date ?? "Not set"}</dd>
        <dt>Due</dt>
        <dd>{due.text}</dd>
        <dt>Description</dt>
        <dd>{invoice.description === undefined || invoice.description === null || invoice.description === "" ? "None" : invoice.description}</dd>
        <dt>Payment</dt>
        <dd>
          {invoice.latest_payment_id === null ? (
            "No payment has been requested for this invoice."
          ) : (
            <a href={`/payments/${invoice.latest_payment_id}`}>View the latest payment</a>
          )}
        </dd>
      </dl>
      <p className="guard-note">The payment service decides on every request using your rules at that moment. This page shows the stored status and never predicts the result.</p>
    </>
  );
}

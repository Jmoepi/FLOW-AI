import type { ReactNode } from "react";
import { StatusBadge } from "./Badge";
import { CopyButton } from "./CopyButton";
import { explainDecision } from "./decision-codes";
import { groupMoney } from "./format";
import { dueInfo, shortDate } from "./invoice-format";
import { invoiceStatus, paymentStatus } from "./status-vocab";
import { shortHash } from "./agent-format";
import type { InvoiceData, PaymentData } from "./types";
export function InvoiceStatus({ status }: { status: string }): ReactNode {
  const s = invoiceStatus(status);
  return <StatusBadge tone={s.tone} icon={s.icon} label={s.label} />;
}
export function PaymentStatus({ status }: { status: string }): ReactNode {
  const s = paymentStatus(status);
  return <StatusBadge tone={s.tone} icon={s.icon} label={s.label} />;
}
/** Invoice rows. The reason for a block is stated in words next to the status. All cells are text. */
export function InvoiceTable({ invoices, today, caption }: { invoices: InvoiceData[]; today: string; caption: string }): ReactNode {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
    <table className="table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Invoice</th>
          <th scope="col">Supplier</th>
          <th scope="col">Route</th>
          <th scope="col">Due</th>
          <th scope="col">Amount</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((i) => {
          const due = dueInfo(i.due_date, today);
          return (
            <tr key={i.id}>
              <td data-label="Invoice">
                <a href={`/invoices/${i.id}`}>{i.invoice_number}</a>
              </td>
              <td data-label="Supplier" className="supplier-name">
                {i.supplier_name}
              </td>
              <td data-label="Route">{i.corridor}</td>
              <td data-label="Due" className={due.urgent ? "due-soon" : undefined}>
                {due.text}
              </td>
              <td data-label="Amount">
                {groupMoney(i.amount)} {i.currency}
              </td>
              <td data-label="Status">
                <InvoiceStatus status={i.status} />
                {i.blocked_code === null ? null : <small className="hint">{explainDecision(i.blocked_code).title}</small>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
/** Payment rows with a short hash and a copy button. The hash is never a link here: only the detail page links out. */
export function PaymentTable({ payments, timezone, caption }: { payments: PaymentData[]; timezone: string; caption: string }): ReactNode {
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
    <table className="table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Payment</th>
          <th scope="col">Supplier</th>
          <th scope="col">Requested</th>
          <th scope="col">Amount</th>
          <th scope="col">Status</th>
          <th scope="col">Transaction</th>
        </tr>
      </thead>
      <tbody>
        {payments.map((p) => (
          <tr key={p.id}>
            <td data-label="Payment">
              <a href={`/payments/${p.id}`}>{p.invoice_number}</a>
            </td>
            <td data-label="Supplier" className="supplier-name">
              {p.supplier_name}
            </td>
            <td data-label="Requested">{shortDate(p.requested_at, timezone)}</td>
            <td data-label="Amount">
              {groupMoney(p.amount)} RLUSD
            </td>
            <td data-label="Status">
              <PaymentStatus status={p.status} />
              {p.failure_code === null ? null : <small className="hint">{explainDecision(p.failure_code).title}</small>}
            </td>
            <td data-label="Transaction">
              {p.tx_hash === null ? (
                "None"
              ) : (
                <>
                  <span className="hash">{shortHash(p.tx_hash)}</span> <CopyButton value={p.tx_hash} label="Transaction hash" />
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

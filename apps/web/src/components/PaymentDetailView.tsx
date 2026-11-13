import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { BlockedNotice } from "./States";
import { PaymentStatus } from "./Tables";
import { formatInstant, groupMoney, shortAddress } from "./format";
import { hashNote } from "./invoice-format";
import { paymentStatus } from "./status-vocab";
import type { PaymentData } from "./types";
export function PaymentDetailView({ payment, timezone }: { payment: PaymentData; timezone: string }): ReactNode {
  const hasHash = payment.tx_hash !== null;
  const link = payment.explorer_url;
  return (
    <>
      <p>
        <a href="/payments">All payments</a>
      </p>
      <h1>Payment for invoice {payment.invoice_number}</h1>
      <p>
        <PaymentStatus status={payment.status} /> <span>{paymentStatus(payment.status).definition}</span>
      </p>
      {payment.status === "blocked" || (payment.status === "failed" && payment.failure_code !== null) ? <BlockedNotice code={payment.failure_code} /> : null}
      <dl className="detail-list">
        <dt>Invoice</dt>
        <dd>
          <a href={`/invoices/${payment.invoice_id}`}>{payment.invoice_number}</a>
        </dd>
        <dt>Supplier</dt>
        <dd>{payment.supplier_name}</dd>
        <dt>Network</dt>
        <dd>{payment.network ?? "XRPL Testnet"}</dd>
        <dt>Destination address</dt>
        <dd>
          {payment.destination_address === undefined ? (
            "Not available"
          ) : (
            <>
              <span className="address">{shortAddress(payment.destination_address)}</span> <CopyButton value={payment.destination_address} label="Destination address" />
            </>
          )}
        </dd>
        <dt>Amount</dt>
        <dd>{groupMoney(payment.amount)} RLUSD (test funds)</dd>
        <dt>Requested</dt>
        <dd>{formatInstant(payment.requested_at, timezone)}</dd>
        <dt>Transaction hash</dt>
        <dd>
          {payment.tx_hash === null ? null : (
            <>
              <span className="tx-hash">{payment.tx_hash}</span> <CopyButton value={payment.tx_hash} label="Transaction hash" />
              <br />
            </>
          )}
          {hashNote(payment.status, hasHash, link !== null)}
          {link === null ? null : (
            <>
              {" "}
              <a href={link} rel="noopener noreferrer" target="_blank">
                View on the XRPL Testnet explorer<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          )}
        </dd>
        <dt>Ledger</dt>
        <dd>{payment.ledger_index === null || payment.ledger_index === undefined ? "Not confirmed yet" : `Ledger ${String(payment.ledger_index)}`}</dd>
        <dt>Confirmed</dt>
        <dd>{payment.validated_at === null || payment.validated_at === undefined ? "Not confirmed yet" : formatInstant(payment.validated_at, timezone)}</dd>
        <dt>Delivered amount</dt>
        <dd>{payment.delivered_amount === null || payment.delivered_amount === undefined ? "Not confirmed yet" : `${groupMoney(payment.delivered_amount)} RLUSD`}</dd>
        <dt>Network fee</dt>
        <dd>{payment.fee_drops === null || payment.fee_drops === undefined ? "Not charged yet" : `${payment.fee_drops} drops of XRP`}</dd>
        <dt>Policy version</dt>
        <dd>{payment.policy_version === undefined ? "Unknown" : `Version ${String(payment.policy_version)} of your payment policy applied`}</dd>
        {payment.failure_message === null || payment.failure_message === undefined || payment.failure_message === "" ? null : (
          <>
            <dt>Failure detail</dt>
            <dd>{payment.failure_message}</dd>
          </>
        )}
        {payment.agent_reason === null || payment.agent_reason === undefined || payment.agent_reason === "" ? null : (
          <>
            <dt>Agent reason</dt>
            <dd>{payment.agent_reason}</dd>
          </>
        )}
      </dl>
    </>
  );
}

import { IdParamsSchema, PaymentsQuerySchema, redactString } from "@flow-ai/contracts";
import { getPaymentForWeb, listPaymentsForWeb, withWebTx, type WebPaymentRow } from "@flow-ai/database";
import { explorerUrl, isTxHash } from "../../components/explorer";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const PAGE = 20;
const CODE = /^[A-Z0-9_]{1,64}$/;
/** The server builds the explorer link from a validated hash; nothing client-supplied is ever stored or returned as a URL. */
export function paymentView(r: WebPaymentRow, withDetail: boolean): Record<string, unknown> {
  const hash = isTxHash(r.tx_hash) ? r.tx_hash : null;
  return {
    id: r.id,
    status: r.status,
    amount: r.amount,
    asset: r.asset_currency,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number,
    supplier_name: r.supplier_name,
    requested_at: r.requested_at,
    tx_hash: hash,
    explorer_url: explorerUrl(r.status, hash),
    failure_code: r.failure_code !== null && CODE.test(r.failure_code) ? r.failure_code : null,
    ...(withDetail
      ? {
          network: "XRPL Testnet",
          destination_address: r.destination_address,
          ledger_index: r.ledger_index,
          validated_at: r.validated_at,
          delivered_amount: r.delivered_amount,
          fee_drops: r.fee_drops,
          policy_version: r.policy_version,
          failure_message: r.failure_message === null ? null : redactString(r.failure_message).slice(0, 500),
          agent_reason: r.agent_reason === null ? null : redactString(r.agent_reason).slice(0, 280),
        }
      : {}),
  };
}
export const paymentsListRoute = defineRoute({
  method: "GET",
  path: "/api/payments",
  role: "owner",
  query: PaymentsQuerySchema,
  handler: async ({ deps, session, query }) => {
    const page = query.page ?? 1;
    const { rows, has_more } = await withWebTx(deps.pool, session.businessId, (c) =>
      listPaymentsForWeb(c, session.businessId, { limit: PAGE, page, ...(query.status === undefined ? {} : { status: query.status }) }),
    );
    return jsonResponse(200, { payments: rows.map((r) => paymentView(r, false)), page, has_more });
  },
});
export const paymentGetRoute = defineRoute({
  method: "GET",
  path: "/api/payments/:id",
  role: "owner",
  params: IdParamsSchema,
  handler: async ({ deps, session, params }) => {
    const row = await withWebTx(deps.pool, session.businessId, (c) => getPaymentForWeb(c, session.businessId, params.id));
    if (row === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
    return jsonResponse(200, { payment: paymentView(row, true) });
  },
});

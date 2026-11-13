import { IdParamsSchema, InvoicesQuerySchema, redactString } from "@flow-ai/contracts";
import { getInvoiceForWeb, listInvoicesForWeb, withWebTx, type WebInvoiceRow } from "@flow-ai/database";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const PAGE = 20;
const CODE = /^[A-Z_]{1,64}$/;
/** Domestic when the supplier is in the business's country, otherwise cross-border (spec 5A.1 display only). */
export const corridorOf = (supplierCountry: string, businessCountry: string): "Domestic" | "Cross-border" => (supplierCountry === businessCountry ? "Domestic" : "Cross-border");
/** The decision code is shown only for a blocked invoice whose latest payment was blocked, and only if it is code-shaped. */
export function blockedCode(r: Pick<WebInvoiceRow, "status" | "latest_payment_status" | "latest_failure_code">): string | null {
  return r.status === "blocked" && r.latest_payment_status === "blocked" && r.latest_failure_code !== null && CODE.test(r.latest_failure_code) ? r.latest_failure_code : null;
}
export function invoiceView(r: WebInvoiceRow, withDetail: boolean): Record<string, unknown> {
  return {
    id: r.id,
    invoice_number: r.invoice_number,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    corridor: corridorOf(r.supplier_country, r.business_country),
    amount: r.amount,
    currency: r.currency,
    due_date: r.due_date,
    status: r.status,
    blocked_code: blockedCode(r),
    latest_payment_id: r.latest_payment_id,
    ...(withDetail
      ? {
          issue_date: r.issue_date,
          supplier_country: r.supplier_country,
          supplier_address: r.supplier_address,
          // Untrusted text (13.1A): redacted, capped, and rendered as text only.
          description: r.description === null ? null : redactString(r.description).slice(0, 2000),
          latest_payment_status: r.latest_payment_status,
        }
      : {}),
  };
}
export const invoicesListRoute = defineRoute({
  method: "GET",
  path: "/api/invoices",
  role: "owner",
  query: InvoicesQuerySchema,
  handler: async ({ deps, session, query }) => {
    const page = query.page ?? 1;
    const { rows, has_more } = await withWebTx(deps.pool, session.businessId, (c) =>
      listInvoicesForWeb(c, session.businessId, { limit: PAGE, page, ...(query.status === undefined ? {} : { status: query.status }) }),
    );
    return jsonResponse(200, { invoices: rows.map((r) => invoiceView(r, false)), page, has_more });
  },
});
export const invoiceGetRoute = defineRoute({
  method: "GET",
  path: "/api/invoices/:id",
  role: "owner",
  params: IdParamsSchema,
  handler: async ({ deps, session, params }) => {
    const row = await withWebTx(deps.pool, session.businessId, (c) => getInvoiceForWeb(c, session.businessId, params.id));
    if (row === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
    return jsonResponse(200, { invoice: invoiceView(row, true) });
  },
});

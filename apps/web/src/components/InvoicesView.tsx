import type { ReactNode } from "react";
import { EmptyState } from "./States";
import { InvoiceTable } from "./Tables";
import { INVOICE_STATUSES, invoiceStatus } from "./status-vocab";
import type { InvoicesPage } from "./types";
/** Status filter as a plain GET form: it works with the keyboard alone and without script. */
export function StatusFilter({ action, statuses, label, current, define }: { action: string; statuses: readonly string[]; label: (s: string) => string; current: string | null; define: string }): ReactNode {
  return (
    <form method="get" action={action} className="filter-form" aria-label="Filter by status">
      <div className="field">
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" name="status" defaultValue={current ?? ""}>
          <option value="">All</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-secondary">
        Apply filter
      </button>
      {define === "" ? null : <p className="hint">{define}</p>}
    </form>
  );
}
export function Pager({ base, status, page, hasMore }: { base: string; status: string | null; page: number; hasMore: boolean }): ReactNode {
  const q = (p: number): string => `${base}?${status === null ? "" : `status=${status}&`}page=${String(p)}`;
  if (page <= 1 && !hasMore) return null;
  return (
    <nav className="pager" aria-label="Pages">
      {page > 1 ? <a href={q(page - 1)}>Previous page</a> : null}
      {page > 1 && hasMore ? " · " : null}
      {hasMore ? <a href={q(page + 1)}>Load more (page {page + 1})</a> : null}
    </nav>
  );
}
export function InvoicesView({ page, status, today }: { page: InvoicesPage; status: string | null; today: string }): ReactNode {
  return (
    <>
      <h1>Invoices</h1>
      <p className="lede">Invoices the agent may be asked to pay. Status shows what is stored. The payment service decides again on every request.</p>
      <StatusFilter action="/invoices" statuses={INVOICE_STATUSES} label={(s) => invoiceStatus(s).label} current={status} define="" />
      {page.invoices.length === 0 ? (
        <EmptyState title={status === null ? "No invoices yet" : "No invoices with this status"}>{status === null ? "Invoices appear here once they are added." : "Choose another status or clear the filter."}</EmptyState>
      ) : (
        <InvoiceTable invoices={page.invoices} today={today} caption={`Invoices, page ${String(page.page)}`} />
      )}
      <Pager base="/invoices" status={status} page={page.page} hasMore={page.has_more} />
    </>
  );
}

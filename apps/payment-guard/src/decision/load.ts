import {
  getActiveWalletForBusiness, getBusiness, getInvoice, getPolicy, getSupplier, getWallet, listPaymentsForInvoice, listReservationsForDay,
  type BusinessRow, type InvoiceRow, type PaymentRow, type PolicyRow, type Queryable, type ReservationRow, type SupplierRow, type WalletRow,
} from "@flow-ai/database";
/** Canonical records the decision is made from. Nothing here comes from the request body (PG-1). */
export interface CanonicalRecords {
  business: BusinessRow;
  wallet: WalletRow;
  policy: PolicyRow;
  invoice: InvoiceRow;
  supplier: SupplierRow;
}
export type LoadResult = { ok: true; records: CanonicalRecords } | { ok: false; reason: "INVOICE_NOT_FOUND" | "RECORD_MISMATCH" | "RECORD_INACTIVE" };
/** Loads invoice -> business, wallet, policy, supplier. `businessPin` (GUARD_BUSINESS_ID) hides other businesses. */
export async function loadCanonical(q: Queryable, invoiceId: string, businessPin: string | undefined): Promise<LoadResult> {
  const invoice = await getInvoice(q, invoiceId);
  if (!invoice || (businessPin !== undefined && invoice.business_id !== businessPin)) return { ok: false, reason: "INVOICE_NOT_FOUND" };
  const [business, wallet, policy, supplier] = await Promise.all([
    getBusiness(q, invoice.business_id),
    getActiveWalletForBusiness(q, invoice.business_id),
    getPolicy(q, invoice.business_id),
    getSupplier(q, invoice.supplier_id),
  ]);
  if (!business || !wallet || !policy || !supplier) return { ok: false, reason: "RECORD_MISMATCH" };
  return { ok: true, records: { business, wallet, policy, invoice, supplier } };
}
/** Re-reads inside the decision transaction, after the policy lock, so nothing decided on is stale. */
export async function reloadCanonical(q: Queryable, before: CanonicalRecords): Promise<CanonicalRecords | null> {
  // Sequential: `q` is a single transaction client, which must not run overlapping queries (pg deprecation).
  const business = await getBusiness(q, before.business.id);
  const wallet = await getWallet(q, before.wallet.id);
  const policy = await getPolicy(q, before.business.id);
  const invoice = await getInvoice(q, before.invoice.id);
  const supplier = await getSupplier(q, before.supplier.id);
  if (!business || !wallet || !policy || !invoice || !supplier) return null;
  return { business, wallet, policy, invoice, supplier };
}
export async function loadReservationsAndPayments(q: Queryable, businessId: string, businessDate: string, invoiceId: string): Promise<{ reservations: ReservationRow[]; payments: PaymentRow[] }> {
  const reservations = await listReservationsForDay(q, businessId, businessDate);
  const payments = await listPaymentsForInvoice(q, invoiceId);
  return { reservations, payments };
}

import {
  DecisionCodeSchema, type DecisionCode, type GuardInvoiceList, type GuardInvoiceView, type GuardSnapshotView,
} from "@flow-ai/contracts";
import {
  dbNow, getActiveWalletForBusiness, getInvoice, getLatestSnapshot, getPolicy, getSupplier, listBusinessIds, listOpenInvoicesForBusiness,
  listReservationsForDay, getBusiness, type InvoiceRow,
} from "@flow-ai/database";
import { Dec, businessDate, formatMoney } from "@flow-ai/policy-engine";
import { previewEligibility, type ServiceDeps } from "./payments";

/**
 * The business the agent surfaces act on: the pinned GUARD_BUSINESS_ID, else the only business in the database.
 * Anything else (none, or several without a pin) is null and the routes answer 503 (fail closed). The agent never
 * sends a business id.
 */
export async function resolveAgentBusinessId(deps: ServiceDeps): Promise<string | null> {
  if (deps.config.businessId !== undefined) return deps.config.businessId;
  const ids = await listBusinessIds(deps.pool);
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Informational snapshot for the agent. No per-payment cap, allowed assets, policy version or kill-switch value. */
export async function getAgentSnapshot(deps: ServiceDeps, businessId: string): Promise<GuardSnapshotView | null> {
  const { pool, config } = deps;
  const business = await getBusiness(pool, businessId);
  if (!business) return null;
  const [policy, wallet] = await Promise.all([getPolicy(pool, businessId), getActiveWalletForBusiness(pool, businessId)]);
  if (!policy) return null;
  const snapshot = wallet ? await getLatestSnapshot(pool, wallet.id) : null;
  const now = await dbNow(pool);
  const today = businessDate(now.getTime(), business.timezone);
  let spent = new Dec(0);
  for (const r of await listReservationsForDay(pool, businessId, today)) if (r.status !== "released") spent = spent.plus(new Dec(r.amount));
  const left = new Dec(policy.daily_spend_limit).minus(spent);
  const stale = snapshot === null || now.getTime() - Date.parse(snapshot.as_of) > 3 * config.balancePollIntervalSeconds * 1000;
  return {
    as_of: snapshot?.as_of ?? null,
    rlusd_balance: snapshot?.rlusd_balance ?? null,
    minimum_reserve: policy.minimum_reserve,
    daily_remaining: formatMoney(left.isNegative() ? new Dec(0) : left),
    automation: policy.enabled ? "enabled" : "disabled",
    network: config.network,
    stale,
  };
}

async function toView(deps: ServiceDeps, inv: InvoiceRow): Promise<GuardInvoiceView | null> {
  const [supplier, preview] = await Promise.all([getSupplier(deps.pool, inv.supplier_id), previewEligibility(deps, inv.id)]);
  if (!supplier || !preview) return null;
  const known = preview.failed_checks.flatMap((c): DecisionCode[] => {
    const p = DecisionCodeSchema.safeParse(c);
    return p.success ? [p.data] : [];
  });
  const failed = known.length === 0 && !preview.eligible ? (["INTERNAL_ERROR"] as DecisionCode[]) : known;
  return {
    invoice_id: inv.id,
    invoice_number: inv.invoice_number,
    due_date: inv.due_date,
    amount: inv.amount,
    currency: inv.currency,
    status: inv.status,
    supplier: { name: supplier.name, country_code: supplier.country_code, approved: supplier.is_approved && supplier.is_active },
    description: inv.description,
    eligibility: { eligible: preview.eligible, failed_checks: failed, as_of: preview.as_of, preview: true },
  };
}

const CONCURRENCY = 3;

/** Open invoices with their read-only eligibility preview (9.5), at most 3 previews in flight. */
export async function listAgentInvoices(deps: ServiceDeps, businessId: string, limit: number): Promise<GuardInvoiceList> {
  const rows = await listOpenInvoicesForBusiness(deps.pool, businessId, limit);
  const out: (GuardInvoiceView | null)[] = new Array<GuardInvoiceView | null>(rows.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const inv = rows[i];
      if (inv === undefined) return;
      out[i] = await toView(deps, inv);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return { invoices: out.filter((v): v is GuardInvoiceView => v !== null) };
}

/** One invoice of this business, or null (other tenants and unknown ids look the same). */
export async function getAgentInvoice(deps: ServiceDeps, businessId: string, invoiceId: string): Promise<GuardInvoiceView | null> {
  const inv = await getInvoice(deps.pool, invoiceId);
  if (!inv || inv.business_id !== businessId) return null;
  return toView(deps, inv);
}

import { z } from "zod";
import { DbError } from "../errors";
import { isoOrNull, moneyOut, run, runOne, uuid, type Queryable } from "../db";
import type { BusinessRow, InvoiceRow, InvoiceStatus, PolicyRow, SupplierRow, WalletRow } from "./types";

/** Reads of owner-controlled records (businesses, wallets, suppliers, invoices, policies). */

const AssetsSchema = z.array(z.strictObject({ currency: z.string().min(1), issuer: z.string().min(1) }));
const INVOICE_STATUSES: readonly InvoiceStatus[] = ["draft", "open", "processing", "paid", "blocked", "cancelled"];

export async function getBusiness(q: Queryable, id: string): Promise<BusinessRow | null> {
  return runOne<BusinessRow>(q, "SELECT id, name, country_code, timezone FROM businesses WHERE id = $1", [uuid(id)]);
}

export async function getWallet(q: Queryable, id: string): Promise<WalletRow | null> {
  return runOne<WalletRow>(
    q,
    `SELECT id, business_id, network, address, asset_currency, asset_issuer, signing_key_mode, is_active
       FROM treasury_wallets WHERE id = $1`,
    [uuid(id)],
  );
}

export async function listActiveWallets(q: Queryable): Promise<WalletRow[]> {
  return run<WalletRow>(
    q,
    `SELECT id, business_id, network, address, asset_currency, asset_issuer, signing_key_mode, is_active
       FROM treasury_wallets WHERE is_active ORDER BY created_at, id LIMIT 100`,
  );
}

export async function getActiveWalletForBusiness(q: Queryable, businessId: string): Promise<WalletRow | null> {
  return runOne<WalletRow>(
    q,
    `SELECT id, business_id, network, address, asset_currency, asset_issuer, signing_key_mode, is_active
       FROM treasury_wallets WHERE business_id = $1 AND is_active ORDER BY created_at, id LIMIT 1`,
    [uuid(businessId)],
  );
}

export async function getSupplier(q: Queryable, id: string): Promise<SupplierRow | null> {
  return runOne<SupplierRow>(
    q,
    "SELECT id, business_id, name, xrpl_address, country_code, is_approved, is_active FROM suppliers WHERE id = $1",
    [uuid(id)],
  );
}

interface InvoiceDbRow extends Omit<InvoiceRow, "amount" | "status" | "priority"> {
  amount: unknown;
  status: string;
  priority: number | null;
}

function mapInvoice(r: InvoiceDbRow): InvoiceRow {
  if (!INVOICE_STATUSES.includes(r.status as InvoiceStatus)) throw new DbError("DATA_INTEGRITY");
  return { ...r, amount: moneyOut(r.amount), status: r.status as InvoiceStatus };
}

const INVOICE_COLS = `id, business_id, supplier_id, invoice_number, description, amount, currency,
       issue_date::text AS issue_date, due_date::text AS due_date, priority, status`;

export async function getInvoice(q: Queryable, id: string): Promise<InvoiceRow | null> {
  const r = await runOne<InvoiceDbRow>(q, `SELECT ${INVOICE_COLS} FROM invoices WHERE id = $1`, [uuid(id)]);
  return r ? mapInvoice(r) : null;
}

/** Guard-side invoice status update (column-level grant: status, updated_at only). */
export async function setInvoiceStatus(q: Queryable, id: string, status: InvoiceStatus): Promise<void> {
  if (!INVOICE_STATUSES.includes(status)) throw new DbError("INVALID_INPUT");
  const rows = await run<{ id: string }>(q, "UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1 RETURNING id", [uuid(id), status]);
  if (rows.length === 0) throw new DbError("NOT_FOUND");
}

interface PolicyDbRow {
  id: string;
  business_id: string;
  enabled: boolean;
  max_payment_amount: unknown;
  daily_spend_limit: unknown;
  minimum_reserve: unknown;
  allowed_assets: unknown;
  valid_until: unknown;
  version: number;
  updated_by: string | null;
}

function mapPolicy(r: PolicyDbRow): PolicyRow {
  const assets = AssetsSchema.safeParse(r.allowed_assets);
  if (!assets.success) throw new DbError("DATA_INTEGRITY");
  return {
    id: r.id,
    business_id: r.business_id,
    enabled: r.enabled,
    max_payment_amount: moneyOut(r.max_payment_amount),
    daily_spend_limit: moneyOut(r.daily_spend_limit),
    minimum_reserve: moneyOut(r.minimum_reserve),
    allowed_assets: assets.data,
    valid_until: isoOrNull(r.valid_until),
    version: r.version,
    updated_by: r.updated_by,
  };
}

const POLICY_COLS = "id, business_id, enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets, valid_until, version, updated_by";

export async function getPolicy(q: Queryable, businessId: string): Promise<PolicyRow | null> {
  const r = await runOne<PolicyDbRow>(q, `SELECT ${POLICY_COLS} FROM treasury_policies WHERE business_id = $1`, [uuid(businessId)]);
  return r ? mapPolicy(r) : null;
}

/**
 * Serialises decisions per business inside the CURRENT transaction, then returns the policy. Uses the same
 * transaction-scoped advisory lock key as the reservation cap trigger (the guard has no UPDATE right on policies, so
 * SELECT ... FOR UPDATE is not available to it by design). Must be called inside withTransaction.
 */
export async function lockPolicyForUpdate(q: Queryable, businessId: string): Promise<PolicyRow | null> {
  const id = uuid(businessId);
  await run(q, "SELECT pg_advisory_xact_lock(hashtextextended('policy:' || $1::text, 0))", [id]);
  return getPolicy(q, id);
}


import { scaleDemoFixture } from "@flow-ai/policy-engine";
import { DbError } from "./errors";
import { moneyIn, run, runOne, uuid, type Queryable } from "./db";

export const DEMO_BUSINESS_NAME = "DEMO Business (Testnet sample data, not a customer)";

export interface SeedInput {
  /** Treasury wallet public address (never a seed). */
  treasuryAddress: string;
  issuer: string;
  currencyHex: string;
  /** Actual RLUSD balance, used to scale the spec 13A fixture. */
  balance: string;
  /** Public addresses for Supplier A (NG), B (KE), C (ZA). */
  supplierA: string;
  supplierB: string;
  supplierC: string;
}

export interface SeedResult {
  business_id: string;
  wallet_id: string;
  created: boolean;
}

/**
 * Seeds the clearly labelled demo business (spec 8.2 / 13A) with amounts scaled to the real balance. Idempotent: an
 * existing demo business is returned untouched. Needs an ADMIN pool (superuser or BYPASSRLS owner); the guard role
 * cannot write these tables by design.
 */
export async function seedDemo(admin: Queryable, input: SeedInput): Promise<SeedResult> {
  const fx = scaleDemoFixture(moneyIn(input.balance));
  if (fx === null) throw new DbError("INVALID_INPUT");
  const existing = await runOne<{ id: string }>(admin, "SELECT id FROM businesses WHERE name = $1", [DEMO_BUSINESS_NAME]);
  if (existing) {
    const w = await runOne<{ id: string }>(admin, "SELECT id FROM treasury_wallets WHERE business_id = $1 ORDER BY created_at LIMIT 1", [existing.id]);
    return { business_id: existing.id, wallet_id: w?.id ?? "", created: false };
  }
  const biz = await runOne<{ id: string }>(admin, "INSERT INTO businesses (name) VALUES ($1) RETURNING id", [DEMO_BUSINESS_NAME]);
  const businessId = uuid(biz?.id);
  const wallet = await runOne<{ id: string }>(
    admin,
    `INSERT INTO treasury_wallets (business_id, network, address, asset_currency, asset_issuer)
     VALUES ($1, 'xrpl-testnet', $2, $3, $4) RETURNING id`,
    [businessId, input.treasuryAddress, input.currencyHex, input.issuer],
  );
  await run(
    admin,
    `INSERT INTO treasury_policies (business_id, enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets, updated_by)
     VALUES ($1, true, $2, $3, $4, $5::jsonb, 'seed')`,
    [businessId, fx.max_payment_amount, fx.daily_spend_limit, fx.minimum_reserve, JSON.stringify([{ currency: input.currencyHex, issuer: input.issuer }])],
  );
  const supplierIds = new Map<string, string>();
  const suppliers: [string, string, string, boolean][] = [
    ["Supplier A", input.supplierA, "NG", true],
    ["Supplier B", input.supplierB, "KE", false],
    ["Supplier C", input.supplierC, "ZA", true],
  ];
  for (const [name, address, country, approved] of suppliers) {
    const s = await runOne<{ id: string }>(
      admin,
      "INSERT INTO suppliers (business_id, name, xrpl_address, country_code, is_approved) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [businessId, name, address, country, approved],
    );
    supplierIds.set(name, uuid(s?.id));
  }
  const invoices: [string, string, string][] = [
    ["INV-101", "Supplier A", fx.invoices["INV-101"]],
    ["INV-102", "Supplier A", fx.invoices["INV-102"]],
    ["INV-103", "Supplier B", fx.invoices["INV-103"]],
    ["INV-104", "Supplier A", fx.invoices["INV-104"]],
    ["INV-105", "Supplier C", fx.invoices["INV-105"]],
  ];
  for (const [number, supplier, amount] of invoices) {
    await run(
      admin,
      `INSERT INTO invoices (business_id, supplier_id, invoice_number, description, amount, currency, issue_date, due_date, status)
       VALUES ($1, $2, $3, $4, $5, 'RLUSD', current_date, current_date + 30, 'open')`,
      [businessId, supplierIds.get(supplier), number, `DEMO invoice ${number} (sample data)`, moneyIn(amount)],
    );
  }
  return { business_id: businessId, wallet_id: uuid(wallet?.id), created: true };
}

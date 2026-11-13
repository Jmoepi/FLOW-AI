import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Syntactically valid XRPL-style addresses for DB constraint tests (not real accounts). */
export const addr = (n: number): string => `r${[...n.toString(9)].map((d) => String(Number(d) + 1)).join("").padStart(25, "1")}`;
export const ISSUER = addr(900);
export const CURRENCY_HEX = "524C555344000000000000000000000000000000";
export const TX_HASH = "A".repeat(64);

export interface Fixture {
  businessId: string;
  walletId: string;
  supplierId: string;
}

export async function makeBusiness(admin: pg.Pool, dailyLimit = "4"): Promise<Fixture> {
  const b = await admin.query<{ id: string }>("INSERT INTO businesses (name) VALUES ($1) RETURNING id", [`test-${randomUUID()}`]);
  const businessId = b.rows[0]?.id as string;
  const w = await admin.query<{ id: string }>(
    "INSERT INTO treasury_wallets (business_id, network, address, asset_currency, asset_issuer) VALUES ($1,'xrpl-testnet',$2,$3,$4) RETURNING id",
    [businessId, addr(1), CURRENCY_HEX, ISSUER],
  );
  await admin.query(
    "INSERT INTO treasury_policies (business_id, enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets) VALUES ($1,true,'2',$2,'2.5','[]')",
    [businessId, dailyLimit],
  );
  const s = await admin.query<{ id: string }>(
    "INSERT INTO suppliers (business_id, name, xrpl_address, country_code, is_approved) VALUES ($1,'S',$2,'NG',true) RETURNING id",
    [businessId, addr(2)],
  );
  return { businessId, walletId: w.rows[0]?.id as string, supplierId: s.rows[0]?.id as string };
}

export async function makeInvoice(admin: pg.Pool, f: Fixture, amount = "1"): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO invoices (business_id, supplier_id, invoice_number, amount, issue_date, due_date, status)
     VALUES ($1,$2,$3,$4,current_date,current_date,'open') RETURNING id`,
    [f.businessId, f.supplierId, `INV-${randomUUID()}`, amount],
  );
  return r.rows[0]?.id as string;
}

export interface PaymentOpts {
  amount?: string;
  key?: string;
  status?: "requested" | "blocked";
  invoiceId?: string;
}

/** Inserts a payment through the admin pool (the insert trigger still applies). */
export async function makePayment(admin: pg.Pool, f: Fixture, o: PaymentOpts = {}): Promise<{ id: string; invoiceId: string }> {
  const invoiceId = o.invoiceId ?? (await makeInvoice(admin, f, o.amount ?? "1"));
  const status = o.status ?? "requested";
  const r = await admin.query<{ id: string }>(
    `INSERT INTO payments (business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount,
        destination_address, status, policy_version, idempotency_key, request_hash, failure_code, business_date)
     VALUES ($1,$2,$3,$4,'xrpl-testnet',$5,$6,$7,$8,$9,1,$10,$11,$12,current_date) RETURNING id`,
    [f.businessId, invoiceId, f.supplierId, f.walletId, CURRENCY_HEX, ISSUER, o.amount ?? "1", addr(2), status, o.key ?? `key-${randomUUID()}`, "b".repeat(64), status === "blocked" ? "DAILY_LIMIT_EXCEEDED" : null],
  );
  return { id: r.rows[0]?.id as string, invoiceId };
}

export type PaymentState = "requested" | "blocked" | "reserved" | "submitted" | "pending_confirmation" | "validated" | "failed" | "cancelled";

/** Walks a fresh payment to `target` along legal transitions only. */
export async function paymentAt(admin: pg.Pool, f: Fixture, target: PaymentState, o: PaymentOpts = {}): Promise<{ id: string; invoiceId: string }> {
  if (target === "blocked") return makePayment(admin, f, { ...o, status: "blocked" });
  const p = await makePayment(admin, f, o);
  const step = (to: string, extra = ""): Promise<unknown> => admin.query(`UPDATE payments SET status = $2${extra} WHERE id = $1`, [p.id, to]);
  const sign = `, tx_hash = '${TX_HASH}', last_ledger_sequence = 100, first_ledger_sequence = 90`;
  switch (target) {
    case "requested":
      break;
    case "cancelled":
      await step("cancelled");
      break;
    case "reserved":
      await step("reserved");
      break;
    default:
      await step("reserved");
      await step("submitted", sign);
      if (target !== "submitted") await step(target);
  }
  return p;
}

export async function reserve(admin: pg.Pool, f: Fixture, paymentId: string, amount = "1"): Promise<void> {
  await admin.query("INSERT INTO daily_spend_reservations (business_id, business_date, payment_id, amount, status) VALUES ($1,current_date,$2,$3,'reserved')", [f.businessId, paymentId, amount]);
}

export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "ok";
}

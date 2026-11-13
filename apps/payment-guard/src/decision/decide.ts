import { type PolicyDecision } from "@flow-ai/contracts";
import type { PaymentRow, ReservationRow } from "@flow-ai/database";
import { evaluatePolicy } from "@flow-ai/policy-engine";
import type { GuardConfig } from "../config";
import type { CanonicalRecords } from "./load";
/** Conservative fee estimate used only for the XRPL reserve check (drops). The real fee is set at autofill. */
export const ESTIMATED_FEE_DROPS = "200";
export interface LedgerFacts {
  /** Effective RLUSD balance (live minus in-flight holds) or null when unavailable. */
  rlusdBalance: string | null;
  xrpDrops: string | null;
  baseReserveDrops: string;
  ownerReserveDrops: string;
  ownerCount: number;
  trustline: "present" | "absent" | "unknown";
}
export interface DecideInput {
  now: string;
  /** Raw PAYMENT_EXECUTION_ENABLED value read at request time (13.1C). */
  killSwitchValue: string | undefined;
  request: { invoice_id: string; idempotency_key: string; agent_reason?: string | undefined };
  records: CanonicalRecords;
  config: Pick<GuardConfig, "network" | "rlusd">;
  ledger: LedgerFacts;
  reservations: readonly ReservationRow[];
  payments: readonly PaymentRow[];
}
/** Builds the engine input from canonical records, ledger facts and config only. The request carries no money or destination. */
export function decide(i: DecideInput): PolicyDecision {
  const { business, wallet, policy, invoice, supplier } = i.records;
  return evaluatePolicy({
    now: i.now,
    kill_switch_value: i.killSwitchValue,
    request: {
      invoice_id: i.request.invoice_id,
      idempotency_key: i.request.idempotency_key,
      ...(i.request.agent_reason === undefined ? {} : { agent_reason: i.request.agent_reason }),
    },
    business: { id: business.id, is_active: true, timezone: business.timezone },
    wallet: {
      id: wallet.id, business_id: wallet.business_id, network: wallet.network, address: wallet.address,
      asset_currency: wallet.asset_currency, asset_issuer: wallet.asset_issuer, is_active: wallet.is_active,
    },
    policy: {
      enabled: policy.enabled, max_payment_amount: policy.max_payment_amount, daily_spend_limit: policy.daily_spend_limit,
      minimum_reserve: policy.minimum_reserve, allowed_assets: policy.allowed_assets, valid_until: policy.valid_until, version: policy.version,
    },
    invoice: { id: invoice.id, business_id: invoice.business_id, supplier_id: invoice.supplier_id, amount: invoice.amount, currency: invoice.currency, status: invoice.status },
    supplier: {
      id: supplier.id, business_id: supplier.business_id, xrpl_address: supplier.xrpl_address, is_approved: supplier.is_approved,
      is_active: supplier.is_active, country_code: supplier.country_code,
    },
    config: { network: i.config.network, rlusd_currency_hex: i.config.rlusd.currencyHex, rlusd_issuer: i.config.rlusd.issuer, rlusd_display_symbol: i.config.rlusd.displaySymbol },
    balances: { rlusd_balance: i.ledger.rlusdBalance, xrp_balance_drops: i.ledger.xrpDrops },
    xrpl_reserves: {
      base_reserve_drops: i.ledger.baseReserveDrops, owner_reserve_drops: i.ledger.ownerReserveDrops,
      treasury_owner_count: i.ledger.ownerCount, estimated_fee_drops: ESTIMATED_FEE_DROPS,
    },
    destination_trustline: i.ledger.trustline,
    reservations: i.reservations.map((r) => ({ payment_id: r.payment_id, business_date: r.business_date, amount: r.amount, status: r.status })),
    payments: i.payments.map((p) => ({ id: p.id, invoice_id: p.invoice_id, idempotency_key: p.idempotency_key, status: p.status })),
  });
}

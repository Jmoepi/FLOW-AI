import type { PolicyEvaluationRequest } from "@flow-ai/contracts";

export const TREASURY = "rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo";
export const SUPPLIER_A = "rpc4DFfxB6aXkbEPJTAGXLG4oZQuWpTXnT";
export const SUPPLIER_C = "rNRXXz44CVbkCKxjAhrv5q83NgzDMHm4Af";
export const RLUSD_HEX = "524C555344000000000000000000000000000000";
export const RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

/** Spec 13A policy and an eligible INV-101 request at a 1,000.00 RLUSD balance. */
export function baseRequest(): PolicyEvaluationRequest {
  return {
    now: "2026-03-10T08:00:00Z",
    kill_switch_value: "true",
    request: { invoice_id: "inv-101", idempotency_key: "idem-1", agent_reason: "Due soon." },
    business: { id: "biz-1", is_active: true, timezone: "Africa/Johannesburg" },
    wallet: {
      id: "wal-1",
      business_id: "biz-1",
      network: "xrpl-testnet",
      address: TREASURY,
      asset_currency: RLUSD_HEX,
      asset_issuer: RLUSD_ISSUER,
      is_active: true,
    },
    policy: {
      enabled: true,
      max_payment_amount: "200.00",
      daily_spend_limit: "400.00",
      minimum_reserve: "250.00",
      allowed_assets: [{ currency: RLUSD_HEX, issuer: RLUSD_ISSUER }],
      valid_until: null,
      version: 4,
    },
    invoice: { id: "inv-101", business_id: "biz-1", supplier_id: "sup-a", amount: "120.00", currency: "RLUSD", status: "open" },
    supplier: { id: "sup-a", business_id: "biz-1", xrpl_address: SUPPLIER_A, is_approved: true, is_active: true, country_code: "NG" },
    config: { network: "xrpl-testnet", rlusd_currency_hex: RLUSD_HEX, rlusd_issuer: RLUSD_ISSUER, rlusd_display_symbol: "RLUSD" },
    balances: { rlusd_balance: "1000.00", xrp_balance_drops: "99999988" },
    xrpl_reserves: { base_reserve_drops: "1000000", owner_reserve_drops: "200000", treasury_owner_count: 1, estimated_fee_drops: "12" },
    destination_trustline: "present",
    reservations: [],
    payments: [],
  };
}

/** Return a deep copy of the base request with a mutation applied. */
export function make(mutate?: (r: PolicyEvaluationRequest) => void): PolicyEvaluationRequest {
  const r = structuredClone(baseRequest());
  mutate?.(r);
  return r;
}

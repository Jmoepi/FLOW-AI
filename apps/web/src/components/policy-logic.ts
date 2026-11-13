import { fromUtcInput, isMoney, microOf, rlusd, toUtcInput } from "./format";
import type { PolicyData, RlusdPair } from "./types";
/**
 * Client-side mirror of the server rules, for usability only (WB: the server stays the authority and re-validates
 * everything). All comparisons use exact integer micro units, never floating point.
 */
export interface Draft {
  enabled: boolean;
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  allowRlusd: boolean;
  hasExpiry: boolean;
  expiry: string;
}
export type FieldKey = "max_payment_amount" | "daily_spend_limit" | "minimum_reserve" | "valid_until";
export type FieldErrors = Partial<Record<FieldKey, string>>;
export interface PolicyPayload {
  enabled: boolean;
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  allowed_assets: RlusdPair[];
  valid_until: string | null;
}
const BOUND = 1_000_000_000n * 1_000_000n;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;
export const hasPair = (assets: readonly RlusdPair[], pair: RlusdPair): boolean => assets.some((a) => a.currency === pair.currency && a.issuer === pair.issuer);
export function draftFrom(p: PolicyData, pair: RlusdPair): Draft {
  return {
    enabled: p.enabled,
    max_payment_amount: p.max_payment_amount,
    daily_spend_limit: p.daily_spend_limit,
    minimum_reserve: p.minimum_reserve,
    allowRlusd: hasPair(p.allowed_assets, pair),
    hasExpiry: p.valid_until !== null,
    expiry: toUtcInput(p.valid_until),
  };
}
export function payloadFromSaved(p: PolicyData): PolicyPayload {
  return {
    enabled: p.enabled,
    max_payment_amount: p.max_payment_amount,
    daily_spend_limit: p.daily_spend_limit,
    minimum_reserve: p.minimum_reserve,
    allowed_assets: p.allowed_assets.map((a) => ({ currency: a.currency, issuer: a.issuer })),
    valid_until: p.valid_until,
  };
}
const MONEY_HELP = "Enter a plain number such as 250 or 250.50, with up to 6 decimals and no commas.";
export function validate(d: Draft, pair: RlusdPair, nowMs: number): { payload: PolicyPayload | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const money = (key: "max_payment_amount" | "daily_spend_limit" | "minimum_reserve"): bigint | null => {
    const v = d[key].trim();
    const micro = microOf(v);
    if (!isMoney(v) || micro === null) errors[key] = MONEY_HELP;
    else if (micro > BOUND) errors[key] = "That amount is above the allowed maximum of 1,000,000,000 RLUSD.";
    return micro;
  };
  const max = money("max_payment_amount");
  const daily = money("daily_spend_limit");
  money("minimum_reserve");
  if (max !== null && daily !== null && max > daily && errors.max_payment_amount === undefined) errors.max_payment_amount = "The per-payment limit cannot be higher than the daily limit.";
  let validUntil: string | null = null;
  if (d.hasExpiry) {
    const iso = fromUtcInput(d.expiry);
    if (iso === null) errors.valid_until = "Enter a real date and time, for example 2026-12-31 18:00.";
    else if (Date.parse(iso) <= nowMs) errors.valid_until = "The expiry must be in the future.";
    else if (Date.parse(iso) > nowMs + YEAR_MS) errors.valid_until = "The expiry must be within one year from now.";
    else validUntil = iso;
  }
  if (Object.keys(errors).length > 0) return { payload: null, errors };
  return {
    errors,
    payload: {
      enabled: d.enabled,
      max_payment_amount: d.max_payment_amount.trim(),
      daily_spend_limit: d.daily_spend_limit.trim(),
      minimum_reserve: d.minimum_reserve.trim(),
      allowed_assets: d.allowRlusd ? [{ currency: pair.currency, issuer: pair.issuer }] : [],
      valid_until: validUntil,
    },
  };
}
const expiryValue = (v: string | null): number => (v === null ? Number.POSITIVE_INFINITY : Date.parse(v));
/** Plain-language list of the changes that loosen a protection (needs the review step). Empty when none. */
export function riskyChanges(saved: PolicyData, next: PolicyPayload): string[] {
  const out: string[] = [];
  if (!saved.enabled && next.enabled) out.push("Turn automation back on.");
  const up = (label: string, a: string, b: string): void => {
    const x = microOf(a);
    const y = microOf(b);
    if (x !== null && y !== null && y > x) out.push(`Raise the ${label} from ${rlusd(a)} to ${rlusd(b)}.`);
  };
  up("largest single payment", saved.max_payment_amount, next.max_payment_amount);
  up("daily limit", saved.daily_spend_limit, next.daily_spend_limit);
  const r0 = microOf(saved.minimum_reserve);
  const r1 = microOf(next.minimum_reserve);
  if (r0 !== null && r1 !== null && r1 < r0) out.push(`Lower the minimum reserve from ${rlusd(saved.minimum_reserve)} to ${rlusd(next.minimum_reserve)}.`);
  if (next.allowed_assets.some((a) => !hasPair(saved.allowed_assets, a))) out.push("Allow the agent to pay in RLUSD.");
  if (expiryValue(next.valid_until) > expiryValue(saved.valid_until)) out.push(next.valid_until === null ? "Remove the expiry date." : "Extend the expiry date.");
  return out;
}

import Decimal from "decimal.js";
import { MONEY_STRING_PATTERN } from "@flow-ai/contracts";

/**
 * Isolated Decimal constructor: does not touch the global decimal.js config.
 * Inputs are capped at 12 integer + 6 fractional digits (18 significant), so every sum and
 * difference the engine performs is exact at precision 40.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

/**
 * Parse a canonical decimal money string. Returns null for anything else: numbers, NaN,
 * Infinity, negatives, exponents, whitespace, signs, more than 6 decimals, leading zeros.
 * Zero is accepted only when `allowZero` is true.
 */
export function parseMoney(value: unknown, allowZero: boolean): Dec | null {
  if (typeof value !== "string" || !MONEY_STRING_PATTERN.test(value)) return null;
  const d = new Dec(value);
  if (!d.isFinite() || d.isNegative()) return null;
  if (!allowZero && d.isZero()) return null;
  return d;
}

/** Canonical plain-notation string (never exponent form). */
export function formatMoney(d: Dec): string {
  return d.toFixed();
}

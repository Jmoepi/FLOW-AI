import Decimal from "decimal.js";

export interface IssuedAmount {
  currency: string;
  issuer: string;
  value: string;
}

/** Positive decimal string, max 12 integer and 6 fractional digits (same shape as the policy engine). */
// eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored; no ambiguous nested repetition
const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;

/** Validates a money string and returns its canonical form ("1.50" -> "1.5"). Never accepts numbers. */
export function parseAmount(value: unknown): string {
  if (typeof value !== "string" || !AMOUNT_RE.test(value)) {
    throw new Error(`Invalid amount ${JSON.stringify(value)}: expected a decimal string with at most 6 decimals`);
  }
  const d = new Decimal(value);
  if (!d.gt(0)) throw new Error("Invalid amount: must be greater than zero");
  return d.toFixed();
}

export function amountsEqual(a: string, b: string): boolean {
  try {
    return new Decimal(a).eq(new Decimal(b));
  } catch {
    return false;
  }
}

/** Currency hex is case-insensitive, issuer exact, value compared as a decimal (not as text). */
export function issuedAmountsEqual(actual: unknown, expected: IssuedAmount): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const a = actual as Partial<IssuedAmount>;
  return (
    typeof a.currency === "string" &&
    typeof a.issuer === "string" &&
    typeof a.value === "string" &&
    a.currency.toUpperCase() === expected.currency.toUpperCase() &&
    a.issuer === expected.issuer &&
    amountsEqual(a.value, expected.value)
  );
}

/** Exact decimal subtraction for balance deltas. */
export function subtractAmounts(a: string, b: string): string {
  return new Decimal(a).minus(new Decimal(b)).toFixed();
}

/** Exact decimal a > b. */
export function isGreater(a: string, b: string): boolean {
  return new Decimal(a).gt(new Decimal(b));
}

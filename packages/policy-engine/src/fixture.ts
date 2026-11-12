import { Dec, parseMoney } from "./money";

/** Spec 13A demo fixture, authored for a starting treasury of 1,000.00 RLUSD. */
export const FIXTURE_BASE_BALANCE = "1000.00";

export const DEMO_FIXTURE_BASE = {
  max_payment_amount: "200.00",
  daily_spend_limit: "400.00",
  minimum_reserve: "250.00",
  invoices: {
    "INV-101": "120.00",
    "INV-102": "275.00",
    "INV-103": "90.00",
    "INV-104": "800.00",
    "INV-105": "60.00",
  },
} as const;

export interface ScaledDemoFixture {
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  invoices: Record<keyof typeof DEMO_FIXTURE_BASE.invoices, string>;
}

/**
 * Spec 13A scaling rule: multiply every amount by actual_balance / 1000, rounded to cents.
 * Returns null when the balance is not a positive canonical decimal (never guess).
 */
export function scaleDemoFixture(actualBalance: string): ScaledDemoFixture | null {
  const bal = parseMoney(actualBalance, false);
  if (bal === null) return null;
  const factor = bal.div(new Dec(FIXTURE_BASE_BALANCE));
  const scale = (s: string): string => new Dec(s).times(factor).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2);
  const inv = DEMO_FIXTURE_BASE.invoices;
  return {
    max_payment_amount: scale(DEMO_FIXTURE_BASE.max_payment_amount),
    daily_spend_limit: scale(DEMO_FIXTURE_BASE.daily_spend_limit),
    minimum_reserve: scale(DEMO_FIXTURE_BASE.minimum_reserve),
    invoices: {
      "INV-101": scale(inv["INV-101"]),
      "INV-102": scale(inv["INV-102"]),
      "INV-103": scale(inv["INV-103"]),
      "INV-104": scale(inv["INV-104"]),
      "INV-105": scale(inv["INV-105"]),
    },
  };
}

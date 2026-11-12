import { z } from "zod";

/**
 * Money is always a canonical decimal STRING (spec 6.2). Never a JS number.
 * Non-negative, at most 12 integer digits and 6 fractional digits, no sign, no exponent,
 * no whitespace, no leading zeros (except a single "0").
 */
// eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored; no ambiguous nested repetition
export const MONEY_STRING_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
export const MONEY_MAX_DECIMALS = 6;

export const MoneyStringSchema = z.string().regex(MONEY_STRING_PATTERN, "invalid decimal money string");
export type MoneyString = z.infer<typeof MoneyStringSchema>;

/** XRP amounts in integer drops, as a string (bigint-safe). */
export const DROPS_STRING_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
export const DropsStringSchema = z.string().regex(DROPS_STRING_PATTERN, "invalid drops string");
export type DropsString = z.infer<typeof DropsStringSchema>;

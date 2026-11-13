import { z } from "zod";
import { MONEY_STRING_PATTERN, MoneyStringSchema } from "./money";
/**
 * Owner web API contracts (M4). Every input is a strict object: unknown keys (including business_id, user_id,
 * version, updated_by) are rejected, never ignored (IN-4, AZ-2). Money stays a decimal string end to end.
 */
const MICRO = 1_000_000n;
/** Exact scaled integer (6 decimals) of a canonical money string. Never touches floats. */
export function moneyToMicro(value: string): bigint {
  if (!MONEY_STRING_PATTERN.test(value)) throw new RangeError("invalid money string");
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, "0"));
}
/** Business bound for any single policy amount (1e9 RLUSD). */
export const POLICY_AMOUNT_MAX_MICRO = 1_000_000_000n * MICRO;
export const POLICY_MAX_ASSETS = 5;
/** valid_until may be at most this far ahead. */
export const POLICY_MAX_VALIDITY_MS = 366 * 24 * 60 * 60 * 1000;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const CURRENCY_HEX = /^[0-9A-F]{40}$/;
const policyMoney = MoneyStringSchema.refine((v) => MONEY_STRING_PATTERN.test(v) && moneyToMicro(v) <= POLICY_AMOUNT_MAX_MICRO, "amount above the allowed bound");
export const PolicyAssetSchema = z.strictObject({
  currency: z.string().regex(CURRENCY_HEX, "currency must be 40 uppercase hex characters"),
  issuer: z.string().regex(CLASSIC_ADDRESS, "issuer must be a classic address"),
});
// eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Date.parse rolls impossible dates over (Feb 30 becomes Mar 2), so check the calendar date explicitly. */
function isRealDate(value: string): boolean {
  const m = ISO_INSTANT.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
/** Builds the policy update schema with an injectable clock (tests). */
export function createPolicyUpdateSchema(now: () => number = Date.now) {
  return z
    .strictObject({
      enabled: z.boolean(),
      max_payment_amount: policyMoney,
      daily_spend_limit: policyMoney,
      minimum_reserve: policyMoney,
      allowed_assets: z.array(PolicyAssetSchema).max(POLICY_MAX_ASSETS),
      valid_until: z.string().max(40).regex(ISO_INSTANT, "valid_until must be an ISO 8601 instant").nullable(),
      confirm_risky: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      if (MONEY_STRING_PATTERN.test(v.max_payment_amount) && MONEY_STRING_PATTERN.test(v.daily_spend_limit) && moneyToMicro(v.max_payment_amount) > moneyToMicro(v.daily_spend_limit)) {
        ctx.addIssue({ code: "custom", path: ["max_payment_amount"], message: "per-payment limit cannot exceed the daily limit" });
      }
      if (v.valid_until !== null) {
        const ms = Date.parse(v.valid_until);
        if (Number.isNaN(ms) || !isRealDate(v.valid_until)) ctx.addIssue({ code: "custom", path: ["valid_until"], message: "valid_until is not a real date" });
        else if (ms <= now()) ctx.addIssue({ code: "custom", path: ["valid_until"], message: "valid_until must be in the future" });
        else if (ms > now() + POLICY_MAX_VALIDITY_MS) ctx.addIssue({ code: "custom", path: ["valid_until"], message: "valid_until must be within one year" });
      }
      const seen = new Set<string>();
      v.allowed_assets.forEach((a, i) => {
        const k = `${a.currency}|${a.issuer}`;
        if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["allowed_assets", i], message: "duplicate asset" });
        seen.add(k);
      });
    });
}
export const PolicyUpdateSchema = createPolicyUpdateSchema();
export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>;
export const LoginSchema = z.strictObject({
  email: z.string().min(3).max(254),
  password: z.string().min(12).max(256),
});
export type LoginInput = z.infer<typeof LoginSchema>;
export const SupplierPatchSchema = z
  .strictObject({ is_approved: z.boolean().optional(), is_active: z.boolean().optional() })
  .refine((v) => v.is_approved !== undefined || v.is_active !== undefined, "at least one field is required");
export type SupplierPatch = z.infer<typeof SupplierPatchSchema>;
const digits = (max: number) =>
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from a numeric constant, never from input
  z.string().regex(new RegExp(`^[0-9]{1,${String(max)}}$`)).transform(Number);
export const AuditQuerySchema = z.strictObject({
  limit: digits(3).pipe(z.number().int().min(1).max(100)).optional(),
  before_seq: digits(15).pipe(z.number().int().min(1)).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export const AgentRunsQuerySchema = z.strictObject({
  limit: digits(2).pipe(z.number().int().min(1).max(50)).optional(),
  before_seq: digits(15).pipe(z.number().int().min(1)).optional(),
});
export type AgentRunsQuery = z.infer<typeof AgentRunsQuerySchema>;
export const INVOICE_FILTER_STATUSES = ["draft", "open", "processing", "paid", "blocked", "cancelled"] as const;
export const PAYMENT_FILTER_STATUSES = ["requested", "blocked", "reserved", "submitted", "pending_confirmation", "validated", "failed", "cancelled"] as const;
export const InvoicesQuerySchema = z.strictObject({
  status: z.enum(INVOICE_FILTER_STATUSES).optional(),
  page: digits(4).pipe(z.number().int().min(1).max(1000)).optional(),
});
export type InvoicesQuery = z.infer<typeof InvoicesQuerySchema>;
export const PaymentsQuerySchema = z.strictObject({
  status: z.enum(PAYMENT_FILTER_STATUSES).optional(),
  page: digits(4).pipe(z.number().int().min(1).max(1000)).optional(),
});
export type PaymentsQuery = z.infer<typeof PaymentsQuerySchema>;
export const IdParamsSchema = z.strictObject({ id: z.uuid() });
// ---------------------------------------------------------------------------------------------------------------------
// Policy diff
// ---------------------------------------------------------------------------------------------------------------------
export const POLICY_FIELDS = ["enabled", "max_payment_amount", "daily_spend_limit", "minimum_reserve", "allowed_assets", "valid_until"] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];
export interface PolicyFields {
  enabled: boolean;
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  allowed_assets: readonly { currency: string; issuer: string }[];
  valid_until: string | null;
}
export interface PolicyDiff {
  changed: PolicyField[];
  /** Only the changed fields. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** True when the change loosens a protection (needs explicit confirmation). Pausing is never risky. */
  risky: boolean;
  riskyFields: PolicyField[];
}
const assetKeys = (a: PolicyFields["allowed_assets"]): Set<string> => new Set(a.map((x) => `${x.currency}|${x.issuer}`));
function sameAssets(a: PolicyFields["allowed_assets"], b: PolicyFields["allowed_assets"]): boolean {
  const x = assetKeys(a);
  const y = assetKeys(b);
  return x.size === y.size && [...x].every((k) => y.has(k));
}
/** Expiry as a comparable number: no expiry is the furthest future. */
const expiryValue = (v: string | null): number => (v === null ? Number.POSITIVE_INFINITY : Date.parse(v));
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}
/** Decimal-safe (BigInt micro units) comparison of two policies. Pure. */
export function diffPolicy(before: PolicyFields, after: PolicyFields): PolicyDiff {
  const changed: PolicyField[] = [];
  const risky: PolicyField[] = [];
  if (before.enabled !== after.enabled) {
    changed.push("enabled");
    if (!before.enabled && after.enabled) risky.push("enabled");
  }
  for (const f of ["max_payment_amount", "daily_spend_limit"] as const) {
    const b = moneyToMicro(before[f]);
    const a = moneyToMicro(after[f]);
    if (a !== b) {
      changed.push(f);
      if (a > b) risky.push(f);
    }
  }
  {
    const b = moneyToMicro(before.minimum_reserve);
    const a = moneyToMicro(after.minimum_reserve);
    if (a !== b) {
      changed.push("minimum_reserve");
      if (a < b) risky.push("minimum_reserve");
    }
  }
  if (!sameAssets(before.allowed_assets, after.allowed_assets)) {
    changed.push("allowed_assets");
    const had = assetKeys(before.allowed_assets);
    if ([...assetKeys(after.allowed_assets)].some((k) => !had.has(k))) risky.push("allowed_assets");
  }
  if (!sameInstant(before.valid_until, after.valid_until)) {
    changed.push("valid_until");
    if (expiryValue(after.valid_until) > expiryValue(before.valid_until)) risky.push("valid_until");
  }
  const pick = (p: PolicyFields): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of changed) out[f] = f === "allowed_assets" ? p.allowed_assets.map((x) => ({ currency: x.currency, issuer: x.issuer })) : p[f];
    return out;
  };
  return { changed, before: pick(before), after: pick(after), risky: risky.length > 0, riskyFields: risky };
}

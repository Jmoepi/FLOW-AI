import { z } from "zod";
import { DropsStringSchema, MoneyStringSchema } from "./money";
import { TreasuryPolicySchema } from "./policy";

/** Stable machine-readable decision codes (spec 9.3), plus the engine-only additions noted in docs/m2-notes.md. */
export const DECISION_CODES = [
  "AUTOMATION_PAUSED",
  "EXECUTION_DISABLED",
  "MANDATE_EXPIRED",
  "INVOICE_NOT_FOUND",
  "INVOICE_NOT_PAYABLE",
  "SUPPLIER_NOT_APPROVED",
  "INVALID_DESTINATION",
  "ASSET_NOT_ALLOWED",
  "PAYMENT_LIMIT_EXCEEDED",
  "DAILY_LIMIT_EXCEEDED",
  "MINIMUM_RESERVE_BREACHED",
  "INSUFFICIENT_RLUSD_BALANCE",
  "MISSING_RLUSD_TRUSTLINE",
  "XRPL_RESERVE_INSUFFICIENT",
  "DUPLICATE_REQUEST",
  "PAYMENT_ALREADY_IN_PROGRESS",
  "NETWORK_NOT_ALLOWED",
  // Post-decision codes (spec 9.3). Never emitted by the pure engine; kept so the enum is the single list.
  "XRPL_SUBMISSION_FAILED",
  "PARTIAL_DELIVERY",
  "VALIDATION_PENDING",
  // Engine-only additions (not in 9.3).
  "INVALID_REQUEST",
  "INVALID_AMOUNT",
  "SUPPLIER_INACTIVE",
  "RECORD_INACTIVE",
  "RECORD_MISMATCH",
  "REQUEST_MISMATCH",
  "BALANCE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export const DecisionCodeSchema = z.enum(DECISION_CODES);
export type DecisionCode = z.infer<typeof DecisionCodeSchema>;

/** Ordered check identifiers (spec 6.3). The array order IS the evaluation order. */
export const CHECK_IDS = [
  "automation_enabled", // 6.3 #1
  "execution_switch", // 6.3 #1 (13.1C)
  "mandate_valid", // 6.3 #1
  "records_active", // 6.3 #2 (business, wallet)
  "invoice_belongs_to_business", // 6.3 #3
  "records_consistent", // 6.3 #2/#3 linkage
  "invoice_payable", // 6.3 #3
  "request_matches_canonical", // 13.1A: agent claims must match stored records
  "supplier_active", // 6.3 #2
  "supplier_approved", // 6.3 #4
  "destination_valid", // 6.3 #5
  "destination_not_treasury", // 6.3 #5
  "amount_valid", // 6.3 #6
  "per_payment_limit", // 6.3 #6
  "asset_allowed", // 6.3 #6
  "sufficient_rlusd_balance", // 6.3 #7
  "minimum_reserve", // 6.3 #8
  "daily_spend_limit", // 6.3 #9
  "not_duplicate_request", // 6.3 #10
  "no_payment_in_progress", // 6.3 #10
  "network_allowed", // 6.3 #11
  "destination_trustline", // 6.3 #12
  "xrpl_reserve", // 6.3 #12
] as const;
export const CheckIdSchema = z.enum(CHECK_IDS);
export type CheckId = z.infer<typeof CheckIdSchema>;

const IsoInstant = z
  .string()
  // eslint-disable-next-line security/detect-unsafe-regex -- fully bounded and anchored; no ambiguous nested repetition
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/, "expected ISO 8601 instant with Z or offset");

export const InvoiceStatusSchema = z.enum(["draft", "open", "processing", "paid", "blocked", "cancelled"]);
export const PaymentStatusSchema = z.enum([
  "requested",
  "blocked",
  "reserved",
  "submitted",
  "validated",
  "failed",
  "pending_confirmation",
  "cancelled",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export const ReservationStatusSchema = z.enum(["reserved", "committed", "released"]);

/** What the agent sends to the guard (9.2). Unknown keys are deliberately STRIPPED (13.1A: model-supplied facts are ignored, not trusted). Every other contract schema is strict (unknown keys rejected). */
export const AgentPaymentRequestSchema = z.object({
  invoice_id: z.string().min(1).max(128),
  idempotency_key: z.string().min(1).max(128),
  /** 280 characters max (13.1A). Longer values are rejected, not truncated. */
  agent_reason: z.string().max(280).optional(),
  /** Optional claims. They never drive the payment; if present they must equal the canonical records. */
  claimed_amount: z.unknown().optional(),
  claimed_destination: z.unknown().optional(),
});
export type AgentPaymentRequest = z.infer<typeof AgentPaymentRequestSchema>;

/**
 * What the payment guard accepts over HTTP (PG-1, IN-2). Strict: any other key (amount, destination, business_id,
 * tx_blob, ...) is rejected, never echoed. Money and destinations always come from canonical records.
 */
export const GuardPaymentRequestSchema = z.strictObject({
  invoice_id: z.uuid(),
  idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  /** Data only (13.1A). Control characters are rejected so it cannot smuggle log or terminal escapes. */
  agent_reason: z
    .string()
    .max(280)
    // eslint-disable-next-line no-control-regex -- the point is to reject control characters
    .regex(/^[^\u0000-\u001f\u007f]*$/, "control characters are not allowed")
    .optional(),
});
export type GuardPaymentRequest = z.infer<typeof GuardPaymentRequestSchema>;

/**
 * Everything the pure engine needs, resolved by the guard from canonical records and the live ledger.
 * No I/O and no clock inside the engine: `now`, reserves, balances and the kill-switch value are inputs.
 */
export const PolicyEvaluationRequestSchema = z.strictObject({
  /** The decision time (ISO 8601 with Z/offset). Drives mandate expiry and the business-day window. */
  now: IsoInstant,
  /** Raw value of PAYMENT_EXECUTION_ENABLED. Only the exact string "true" allows execution (13.1C). */
  kill_switch_value: z.unknown().optional(),
  request: AgentPaymentRequestSchema,
  business: z.strictObject({
    id: z.string().min(1),
    is_active: z.boolean(),
    /** businesses.timezone, the single source (IANA name, e.g. Africa/Johannesburg). */
    timezone: z.string().min(1),
  }),
  wallet: z.strictObject({
    id: z.string().min(1),
    business_id: z.string().min(1),
    network: z.string(),
    address: z.string(),
    asset_currency: z.string(),
    asset_issuer: z.string(),
    is_active: z.boolean(),
  }),
  policy: TreasuryPolicySchema,
  invoice: z.strictObject({
    id: z.string().min(1),
    business_id: z.string().min(1),
    supplier_id: z.string().min(1),
    /** Deliberately `unknown`: invalid, negative, zero, NaN or numeric values must reach the engine and block with INVALID_AMOUNT. */
    amount: z.unknown(),
    currency: z.string(),
    status: InvoiceStatusSchema,
  }),
  supplier: z.strictObject({
    id: z.string().min(1),
    business_id: z.string().min(1),
    xrpl_address: z.string(),
    /** suppliers.is_approved: the single source of approval (6.1). */
    is_approved: z.boolean(),
    is_active: z.boolean(),
    country_code: z.string().optional(),
  }),
  /** Server-side configuration (10.1). The payment asset is always the configured pair. */
  config: z.strictObject({
    network: z.string(),
    rlusd_currency_hex: z.string().min(1),
    rlusd_issuer: z.string().min(1),
    rlusd_display_symbol: z.string().min(1),
  }),
  balances: z.strictObject({
    /** Live RLUSD balance queried at decision time. null/invalid means unavailable and blocks. */
    rlusd_balance: z.unknown(),
    /** Live treasury XRP balance in drops. null means unavailable and blocks. */
    xrp_balance_drops: DropsStringSchema.nullable(),
  }),
  /** Ledger reserve values queried at runtime (10.2). Never hardcoded in the engine. */
  xrpl_reserves: z.strictObject({
    base_reserve_drops: DropsStringSchema,
    owner_reserve_drops: DropsStringSchema,
    treasury_owner_count: z.number().int().min(0),
    estimated_fee_drops: DropsStringSchema,
  }),
  /** Whether the destination holds the configured RLUSD trust line. "unknown" blocks. */
  destination_trustline: z.enum(["present", "absent", "unknown"]),
  /** daily_spend_reservations rows for the business (any date; the engine filters by business date). */
  reservations: z.array(
    z.strictObject({
      payment_id: z.string(),
      business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amount: MoneyStringSchema,
      status: ReservationStatusSchema,
    }),
  ),
  /** Existing payments for the business (at least those for this invoice or idempotency key). */
  payments: z.array(
    z.strictObject({
      id: z.string(),
      invoice_id: z.string(),
      idempotency_key: z.string(),
      status: PaymentStatusSchema,
    }),
  ),
});
export type PolicyEvaluationRequest = z.infer<typeof PolicyEvaluationRequestSchema>;

export const CheckFailureSchema = z.strictObject({
  check: CheckIdSchema,
  code: DecisionCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type CheckFailure = z.infer<typeof CheckFailureSchema>;

/** The payment the guard may reserve and sign. Present only on allow. Built from canonical records only. */
export const ApprovedPaymentSchema = z.strictObject({
  invoice_id: z.string(),
  supplier_id: z.string(),
  wallet_id: z.string(),
  amount: MoneyStringSchema,
  currency: z.string(),
  asset: z.strictObject({ currency: z.string(), issuer: z.string() }),
  destination: z.string(),
  network: z.string(),
  /** YYYY-MM-DD in the business timezone; the daily_spend_reservations.business_date to use. */
  business_date: z.string(),
});
export type ApprovedPayment = z.infer<typeof ApprovedPaymentSchema>;

export const PolicyDecisionSchema = z.strictObject({
  allowed: z.boolean(),
  /** "ALLOWED" or the code of the FIRST failed check in the 6.3 order. */
  decision_code: z.union([z.literal("ALLOWED"), DecisionCodeSchema]),
  /** Same as decision_code when blocked; null when allowed (9.2 `failure_code`). */
  failure_code: DecisionCodeSchema.nullable(),
  message: z.string(),
  failed_check: CheckIdSchema.nullable(),
  /** Every failed check in evaluation order (the first one is the primary decision). */
  failed_checks: z.array(CheckFailureSchema),
  checks_passed: z.array(CheckIdSchema),
  /** Checks that could not be evaluated because a prerequisite value was invalid. */
  checks_skipped: z.array(CheckIdSchema),
  /** Policy version recorded against the decision (14.1). null only if it could not be read. */
  policy_version: z.number().int().nullable(),
  evaluated_at: z.string().nullable(),
  payment: ApprovedPaymentSchema.nullable(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

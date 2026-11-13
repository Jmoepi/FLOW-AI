import { z } from "zod";
import { DecisionCodeSchema, PaymentStatusSchema } from "./evaluation";
import { MoneyStringSchema } from "./money";
/**
 * Agent and MCP tool contracts (M5, spec 7.2.C-D, 13.1A). Every input is a strict object: unknown keys are rejected,
 * never ignored. Business free text (invoice descriptions, supplier names) is always wrapped as untrusted data.
 */

/** Spec 7.2.D: exactly these five tools. Nothing else is ever exposed. */
export const AGENT_TOOL_NAMES = ["get_business_snapshot", "list_open_invoices", "get_invoice_details", "request_supplier_payment", "get_payment_status"] as const;
export const AgentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const AGENT_RUN_STATUSES = ["running", "paid", "pending", "blocked", "no_candidate", "failed", "timed_out", "limit_exceeded", "interrupted"] as const;
export const AgentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export const AGENT_TERMINAL_STATUSES = ["paid", "pending", "blocked", "no_candidate", "failed", "timed_out", "limit_exceeded", "interrupted"] as const;
export const AgentTerminalStatusSchema = z.enum(AGENT_TERMINAL_STATUSES);
export const AGENT_MODES = ["llm", "deterministic"] as const;
export const AgentModeSchema = z.enum(AGENT_MODES);
export type AgentMode = z.infer<typeof AgentModeSchema>;
export const AGENT_TRIGGERS = ["manual", "interval"] as const;
export const AgentTriggerSchema = z.enum(AGENT_TRIGGERS);
export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;

export const AGENT_REASON_MAX_CHARS = 280;

// ---------------------------------------------------------------------------------------------------------------------
// Text sanitising (13.1A)
// ---------------------------------------------------------------------------------------------------------------------
// C0 and DEL, C1, line/paragraph separators, zero-width characters, bidi embeddings/overrides/isolates, BOM.
// eslint-disable-next-line no-control-regex -- the point is to strip control characters
const STRIP_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Removes control, bidi and zero-width characters, then truncates by code point. Never throws. */
export function sanitizeText(input: string, max: number): string {
  const cleaned = input.replace(STRIP_CHARS, "");
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join("") : cleaned;
}

/** Free text from business data. The flag tells the model (and any reader) this is data, not an instruction. */
export const UntrustedTextSchema = z.strictObject({ untrusted: z.literal(true), text: z.string().max(2000) });
export type UntrustedText = z.infer<typeof UntrustedTextSchema>;
export function untrusted(text: string, max: number): UntrustedText {
  return { untrusted: true, text: sanitizeText(text, max) };
}

/** Plain text, controls stripped, trimmed, at most 280 characters after stripping. Longer values are rejected. */
export const AgentReasonSchema = z
  .string()
  .max(2000)
  .transform((s) => sanitizeText(s, 2000).trim())
  .pipe(z.string().max(AGENT_REASON_MAX_CHARS));

const Uuid = z.uuid();
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

// ---------------------------------------------------------------------------------------------------------------------
// Tool inputs
// ---------------------------------------------------------------------------------------------------------------------
export const GetBusinessSnapshotInputSchema = z.strictObject({});
export const ListOpenInvoicesInputSchema = z.strictObject({ limit: z.number().int().min(1).max(20).optional() });
export const GetInvoiceDetailsInputSchema = z.strictObject({ invoice_id: Uuid });
export const RequestSupplierPaymentInputSchema = z.strictObject({
  invoice_id: Uuid,
  idempotency_key: IdempotencyKeySchema,
  agent_reason: AgentReasonSchema.optional(),
});
export const GetPaymentStatusInputSchema = z
  .strictObject({ payment_id: Uuid.optional(), invoice_id: Uuid.optional() })
  .refine((v) => (v.payment_id === undefined) !== (v.invoice_id === undefined), "provide exactly one of payment_id or invoice_id");

export const AGENT_TOOL_INPUT_SCHEMAS = {
  get_business_snapshot: GetBusinessSnapshotInputSchema,
  list_open_invoices: ListOpenInvoicesInputSchema,
  get_invoice_details: GetInvoiceDetailsInputSchema,
  request_supplier_payment: RequestSupplierPaymentInputSchema,
  get_payment_status: GetPaymentStatusInputSchema,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Guard read views (what the guard returns; also what the fake guard returns in tests)
// ---------------------------------------------------------------------------------------------------------------------
const IsoInstant = z.string().max(40);
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const AutomationStateSchema = z.enum(["enabled", "disabled", "unknown"]);

/** Informational only. No per-payment cap, allowed assets, policy version, kill-switch value or tokens. */
export const GuardSnapshotViewSchema = z.strictObject({
  as_of: IsoInstant.nullable(),
  rlusd_balance: MoneyStringSchema.nullable(),
  minimum_reserve: MoneyStringSchema,
  daily_remaining: MoneyStringSchema,
  automation: AutomationStateSchema,
  network: z.string().max(32),
  stale: z.boolean(),
});
export type GuardSnapshotView = z.infer<typeof GuardSnapshotViewSchema>;

export const EligibilityPreviewSchema = z.strictObject({
  eligible: z.boolean(),
  failed_checks: z.array(DecisionCodeSchema).max(30),
  as_of: IsoInstant,
  preview: z.literal(true),
});

export const GuardInvoiceViewSchema = z.strictObject({
  invoice_id: Uuid,
  invoice_number: z.string().max(200),
  due_date: DateOnly,
  amount: MoneyStringSchema,
  currency: z.string().max(16),
  status: z.string().max(32),
  supplier: z.strictObject({ name: z.string().max(500), country_code: z.string().max(8).nullable(), approved: z.boolean() }),
  description: z.string().max(2000).nullable(),
  eligibility: EligibilityPreviewSchema,
});
export type GuardInvoiceView = z.infer<typeof GuardInvoiceViewSchema>;
export const GuardInvoiceListSchema = z.strictObject({ invoices: z.array(GuardInvoiceViewSchema).max(20) });
export type GuardInvoiceList = z.infer<typeof GuardInvoiceListSchema>;

/** Guard payment responses (9.2). Extra guard fields (destination, checks) are dropped, never forwarded to the model. */
export const GuardPaymentViewSchema = z.object({
  payment_id: Uuid.nullable(),
  status: PaymentStatusSchema,
  amount: MoneyStringSchema.nullable(),
  tx_hash: z.string().max(128).nullable(),
  explorer_url: z.string().max(300).optional(),
  failure_code: DecisionCodeSchema.nullable(),
  message: z.string().max(1000).nullable(),
  /** Present on POST responses; stored-payment reads carry `decision_code` instead (or neither). */
  decision_code: z.string().max(64).nullable().optional(),
  policy_decision: z.object({ decision_code: z.string().max(64), policy_version: z.number().int().nullable() }).optional(),
});
export type GuardPaymentView = z.infer<typeof GuardPaymentViewSchema>;
export const GuardPaymentListSchema = z.object({ payments: z.array(GuardPaymentViewSchema).max(100) });

// ---------------------------------------------------------------------------------------------------------------------
// Tool outputs (what the model sees)
// ---------------------------------------------------------------------------------------------------------------------
export const SnapshotOutputSchema = GuardSnapshotViewSchema;

export const InvoiceItemSchema = z.strictObject({
  invoice_id: Uuid,
  invoice_number: UntrustedTextSchema,
  due_date: DateOnly,
  amount: MoneyStringSchema,
  currency: z.string().max(16),
  status: z.string().max(32),
  supplier: z.strictObject({ name: UntrustedTextSchema, country_code: z.string().max(8).nullable(), approved: z.boolean() }),
  description: UntrustedTextSchema.nullable(),
  eligibility: EligibilityPreviewSchema,
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;
export const ListOpenInvoicesOutputSchema = z.strictObject({ count: z.number().int().min(0).max(20), invoices: z.array(InvoiceItemSchema).max(20) });
export const InvoiceDetailsOutputSchema = z.strictObject({ invoice: InvoiceItemSchema });

export const PaymentResultSchema = z.strictObject({
  payment_id: Uuid.nullable(),
  status: PaymentStatusSchema,
  decision_code: z.string().max(64).nullable(),
  failure_code: DecisionCodeSchema.nullable(),
  message: UntrustedTextSchema.nullable(),
  amount: MoneyStringSchema.nullable(),
  tx_hash: z.string().max(128).nullable(),
  explorer_url: z.string().max(300).nullable(),
  policy_version: z.number().int().nullable(),
});
export type PaymentResult = z.infer<typeof PaymentResultSchema>;
export const PaymentStatusOutputSchema = z.strictObject({ payments: z.array(PaymentResultSchema).max(20) });

export const AGENT_TOOL_OUTPUT_SCHEMAS = {
  get_business_snapshot: SnapshotOutputSchema,
  list_open_invoices: ListOpenInvoicesOutputSchema,
  get_invoice_details: InvoiceDetailsOutputSchema,
  request_supplier_payment: PaymentResultSchema,
  get_payment_status: PaymentStatusOutputSchema,
} as const;

export const TOOL_ERROR_CODES = [
  "INVALID_INPUT",
  "UNKNOWN_TOOL",
  "TOOL_CALL_LIMIT",
  "PAYMENT_LIMIT_PER_RUN",
  "GUARD_UNAVAILABLE",
  "GUARD_TIMEOUT",
  "RATE_LIMITED",
  "GUARD_REJECTED",
  "RUN_TIMEOUT",
  "INTERNAL",
] as const;
export const ToolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
export const ToolErrorSchema = z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: ToolErrorCodeSchema, message: z.string().max(300) }) });
export type ToolError = z.infer<typeof ToolErrorSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Guard run-record contracts (agent-authenticated, append-only; used by WP2)
// ---------------------------------------------------------------------------------------------------------------------
const MAX_EVENT_JSON_BYTES = 4096;
const BoundedJsonObject = z
  .record(z.string().max(64), z.unknown())
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_EVENT_JSON_BYTES, `serialized size must be at most ${String(MAX_EVENT_JSON_BYTES)} bytes`);

export const AgentRunCreateSchema = z.strictObject({ trigger: AgentTriggerSchema, mode: AgentModeSchema });
export type AgentRunCreate = z.infer<typeof AgentRunCreateSchema>;

export const AGENT_EVENT_KINDS = ["tool_call", "decision", "model_turn", "mode_fallback", "note"] as const;
export const AgentRunEventSchema = z.strictObject({
  kind: z.enum(AGENT_EVENT_KINDS),
  tool_name: AgentToolNameSchema.optional(),
  input: BoundedJsonObject.optional(),
  output: BoundedJsonObject.optional(),
  ok: z.boolean().optional(),
  error_code: z.string().regex(/^[A-Z_]{1,64}$/).optional(),
  duration_ms: z.number().int().min(0).max(3_600_000).optional(),
});
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;

/**
 * Finish request. The agent is untrusted: `client_status` is a hint stored apart from the outcome, and `summary` is
 * bounded plain text. The guard DERIVES the stored status, payment and decision from its own records; the optional
 * ids are only cross-checked (a payment must be one this run requested) and never trusted.
 */
export const AgentRunFinishSchema = z.strictObject({
  client_status: AgentTerminalStatusSchema,
  summary: z.string().max(500),
  tool_call_count: z.number().int().min(0).max(5),
  candidate_invoice_id: Uuid.optional(),
  payment_id: Uuid.optional(),
  agent_reason: AgentReasonSchema.optional(),
  effective_mode: AgentModeSchema.optional(),
});
export type AgentRunFinish = z.infer<typeof AgentRunFinishSchema>;

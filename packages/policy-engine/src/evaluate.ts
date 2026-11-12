import { isValidClassicAddress } from "ripple-address-codec";
import {
  CHECK_IDS,
  PolicyEvaluationRequestSchema,
  TESTNET,
  type CheckFailure,
  type CheckId,
  type DecisionCode,
  type PolicyDecision,
  type PolicyEvaluationRequest,
} from "@flow-ai/contracts";
import { Dec, formatMoney, parseMoney } from "./money";
import { businessDate, parseInstant } from "./time";

/** Ripple's Mainnet RLUSD issuer (docs/m0-notes.md). It must never be used in this MVP (10.1). */
const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

const ACTIVE_PAYMENT_STATUSES = new Set(["requested", "reserved", "submitted", "pending_confirmation"]);

type Details = NonNullable<CheckFailure["details"]>;
type Outcome =
  | { kind: "pass" }
  | { kind: "skip" }
  | { kind: "fail"; code: DecisionCode; message: string; details?: Details };

const pass: Outcome = { kind: "pass" };
const skip: Outcome = { kind: "skip" };
const fail = (code: DecisionCode, message: string, details?: Details): Outcome =>
  details ? { kind: "fail", code, message, details } : { kind: "fail", code, message };

interface Ctx {
  req: PolicyEvaluationRequest;
  nowMs: number;
  today: string;
  amount: Dec | null;
  balance: Dec | null;
  maxPayment: Dec;
  dailyLimit: Dec;
  minReserve: Dec;
}

const sameAsset = (a: { currency: string; issuer: string }, b: { currency: string; issuer: string }): boolean =>
  a.currency.toUpperCase() === b.currency.toUpperCase() && a.issuer === b.issuer;

/** Each entry is one numbered check of spec 6.3. The array order is the evaluation order. */
const CHECKS: Record<CheckId, (c: Ctx) => Outcome> = {
  automation_enabled: (c) =>
    c.req.policy.enabled === true
      ? pass
      : fail("AUTOMATION_PAUSED", "Automation is paused. New automated payments are rejected."),

  // 13.1C: fail closed. Only the exact string "true" executes; missing, malformed or unreadable blocks.
  execution_switch: (c) =>
    c.req.kill_switch_value === "true"
      ? pass
      : fail("EXECUTION_DISABLED", "Payment execution is disabled by the emergency switch (missing, malformed or not exactly 'true')."),

  mandate_valid: (c) => {
    const until = c.req.policy.valid_until;
    if (until === null) return pass;
    const untilMs = parseInstant(until);
    if (untilMs === null) return fail("MANDATE_EXPIRED", "The mandate expiry is unreadable, so it is treated as expired. The owner must re-confirm the policy.");
    // Safest reading of "after it passes": the instant of expiry itself is already expired.
    if (c.nowMs >= untilMs) return fail("MANDATE_EXPIRED", `The mandate expired at ${until}. The owner must re-confirm the policy.`, { valid_until: until });
    return pass;
  },

  records_active: (c) => {
    if (!c.req.business.is_active) return fail("RECORD_INACTIVE", "The business is not active.");
    if (!c.req.wallet.is_active) return fail("RECORD_INACTIVE", "The treasury wallet is not active.");
    return pass;
  },

  invoice_belongs_to_business: (c) =>
    c.req.invoice.business_id === c.req.business.id && c.req.request.invoice_id === c.req.invoice.id
      ? pass
      : fail("INVOICE_NOT_FOUND", "Invoice not found for this business."),

  records_consistent: (c) => {
    const { wallet, supplier, invoice, business } = c.req;
    if (wallet.business_id !== business.id) return fail("RECORD_MISMATCH", "The treasury wallet does not belong to this business.");
    if (supplier.id !== invoice.supplier_id) return fail("RECORD_MISMATCH", "The supplier record does not match the invoice supplier.");
    if (supplier.business_id !== business.id) return fail("RECORD_MISMATCH", "The supplier does not belong to this business.");
    return pass;
  },

  invoice_payable: (c) => {
    const { invoice, payments } = c.req;
    if (invoice.status === "processing") return fail("PAYMENT_ALREADY_IN_PROGRESS", "The invoice already has a payment in progress.");
    if (invoice.status !== "open" && invoice.status !== "blocked") {
      return fail("INVOICE_NOT_PAYABLE", `The invoice is ${invoice.status} and cannot be paid.`, { status: invoice.status });
    }
    // 'blocked' only records an earlier policy decision (5A.1); it must stay re-evaluable.
    if (payments.some((p) => p.invoice_id === invoice.id && p.status === "validated")) {
      return fail("INVOICE_NOT_PAYABLE", "The invoice has already been paid.");
    }
    return pass;
  },

  // 13.1A: the agent's claims never drive the payment; any disagreement with canonical records blocks.
  request_matches_canonical: (c) => {
    const { request, supplier } = c.req;
    if (request.claimed_amount !== undefined) {
      const claimed = parseMoney(request.claimed_amount, true);
      if (claimed === null || c.amount === null || !claimed.eq(c.amount)) {
        return fail("REQUEST_MISMATCH", "The requested amount does not match the invoice amount.");
      }
    }
    if (request.claimed_destination !== undefined && request.claimed_destination !== supplier.xrpl_address) {
      return fail("REQUEST_MISMATCH", "The requested destination does not match the supplier's stored address.");
    }
    return pass;
  },

  supplier_active: (c) => (c.req.supplier.is_active === true ? pass : fail("SUPPLIER_INACTIVE", "The supplier is not active.")),

  // The single source of approval is suppliers.is_approved (6.1). country_code is never consulted.
  supplier_approved: (c) =>
    c.req.supplier.is_approved === true ? pass : fail("SUPPLIER_NOT_APPROVED", "The supplier is not approved."),

  destination_valid: (c) =>
    typeof c.req.supplier.xrpl_address === "string" && isValidClassicAddress(c.req.supplier.xrpl_address)
      ? pass
      : fail("INVALID_DESTINATION", "The supplier destination is not a valid XRPL classic address."),

  destination_not_treasury: (c) =>
    c.req.supplier.xrpl_address === c.req.wallet.address
      ? fail("INVALID_DESTINATION", "The destination is the treasury's own address.")
      : pass,

  amount_valid: (c) =>
    c.amount === null
      ? fail("INVALID_AMOUNT", "The invoice amount is not a valid positive decimal with at most 6 decimal places.")
      : pass,

  per_payment_limit: (c) => {
    if (c.amount === null) return skip;
    return c.amount.gt(c.maxPayment)
      ? fail("PAYMENT_LIMIT_EXCEEDED", `The amount ${formatMoney(c.amount)} exceeds the per-payment cap of ${formatMoney(c.maxPayment)}.`, {
          amount: formatMoney(c.amount),
          max_payment_amount: formatMoney(c.maxPayment),
        })
      : pass;
  },

  asset_allowed: (c) => {
    const { invoice, config, policy } = c.req;
    if (invoice.currency !== config.rlusd_display_symbol) {
      return fail("ASSET_NOT_ALLOWED", `The invoice currency ${invoice.currency} is not ${config.rlusd_display_symbol}.`);
    }
    const asset = { currency: config.rlusd_currency_hex, issuer: config.rlusd_issuer };
    return policy.allowed_assets.some((a) => sameAsset(a, asset))
      ? pass
      : fail("ASSET_NOT_ALLOWED", "The payment asset (currency and issuer pair) is not in the allowed assets.");
  },

  sufficient_rlusd_balance: (c) => {
    if (c.balance === null) return fail("BALANCE_UNAVAILABLE", "The live RLUSD balance is unavailable, so the payment is blocked.");
    if (c.amount === null) return skip;
    return c.amount.gt(c.balance)
      ? fail("INSUFFICIENT_RLUSD_BALANCE", `The balance ${formatMoney(c.balance)} cannot cover ${formatMoney(c.amount)}.`, {
          balance: formatMoney(c.balance),
          amount: formatMoney(c.amount),
        })
      : pass;
  },

  minimum_reserve: (c) => {
    if (c.amount === null || c.balance === null) return skip;
    const remaining = c.balance.minus(c.amount);
    return remaining.lt(c.minReserve)
      ? fail(
          "MINIMUM_RESERVE_BREACHED",
          `The remaining balance ${formatMoney(remaining)} would be below the minimum reserve of ${formatMoney(c.minReserve)}.`,
          { remaining_after_payment: formatMoney(remaining), minimum_reserve: formatMoney(c.minReserve) },
        )
      : pass;
  },

  // 6.4: committed AND reserved (pending/uncertain) amounts both count; only 'released' is excluded.
  daily_spend_limit: (c) => {
    if (c.amount === null) return skip;
    let spent = new Dec(0);
    for (const r of c.req.reservations) {
      if (r.business_date === c.today && r.status !== "released") spent = spent.plus(new Dec(r.amount));
    }
    if (spent.plus(c.amount).gt(c.dailyLimit)) {
      const left = Dec.max(c.dailyLimit.minus(spent), 0);
      return fail(
        "DAILY_LIMIT_EXCEEDED",
        `Spent or reserved today ${formatMoney(spent)} plus ${formatMoney(c.amount)} exceeds the daily limit of ${formatMoney(c.dailyLimit)}. Remaining allowance: ${formatMoney(left)}.`,
        { spent_or_reserved: formatMoney(spent), daily_spend_limit: formatMoney(c.dailyLimit), remaining_allowance: formatMoney(left), business_date: c.today },
      );
    }
    return pass;
  },

  not_duplicate_request: (c) => {
    const dup = c.req.payments.find((p) => p.idempotency_key === c.req.request.idempotency_key);
    return dup
      ? fail("DUPLICATE_REQUEST", "This idempotency key was already used. Return the existing payment state; do not resubmit.", {
          existing_payment_id: dup.id,
          existing_status: dup.status,
        })
      : pass;
  },

  no_payment_in_progress: (c) => {
    const active = c.req.payments.find((p) => p.invoice_id === c.req.invoice.id && ACTIVE_PAYMENT_STATUSES.has(p.status));
    return active
      ? fail("PAYMENT_ALREADY_IN_PROGRESS", "The invoice already has a payment in progress.", { existing_payment_id: active.id, existing_status: active.status })
      : pass;
  },

  network_allowed: (c) => {
    const { config, wallet } = c.req;
    if (config.network !== TESTNET || wallet.network !== TESTNET) {
      return fail("NETWORK_NOT_ALLOWED", "Only xrpl-testnet is allowed.");
    }
    if (config.rlusd_issuer === MAINNET_RLUSD_ISSUER) return fail("NETWORK_NOT_ALLOWED", "The Mainnet RLUSD issuer is never allowed.");
    const asset = { currency: config.rlusd_currency_hex, issuer: config.rlusd_issuer };
    if (!sameAsset({ currency: wallet.asset_currency, issuer: wallet.asset_issuer }, asset)) {
      return fail("NETWORK_NOT_ALLOWED", "The treasury wallet asset does not match the configured Testnet RLUSD issuer and currency.");
    }
    return pass;
  },

  destination_trustline: (c) =>
    c.req.destination_trustline === "present"
      ? pass
      : fail(
          "MISSING_RLUSD_TRUSTLINE",
          c.req.destination_trustline === "absent"
            ? "The destination has no RLUSD trust line for the configured issuer."
            : "The destination trust line state is unknown, so the payment is blocked.",
        ),

  // Reserves and fee come from the ledger at runtime (10.2), never from constants here.
  xrpl_reserve: (c) => {
    const { balances, xrpl_reserves: r } = c.req;
    if (balances.xrp_balance_drops === null) return fail("XRPL_RESERVE_INSUFFICIENT", "The treasury XRP balance is unavailable, so the payment is blocked.");
    const required =
      BigInt(r.base_reserve_drops) + BigInt(r.owner_reserve_drops) * BigInt(r.treasury_owner_count) + BigInt(r.estimated_fee_drops);
    const have = BigInt(balances.xrp_balance_drops);
    return have < required
      ? fail("XRPL_RESERVE_INSUFFICIENT", "The treasury lacks enough XRP for its account reserve plus the network fee.", {
          xrp_balance_drops: have.toString(),
          required_drops: required.toString(),
        })
      : pass;
  },
};

function blocked(code: DecisionCode, message: string, policyVersion: number | null, evaluatedAt: string | null, check: CheckId | null = null): PolicyDecision {
  return {
    allowed: false,
    decision_code: code,
    failure_code: code,
    message,
    failed_check: check,
    failed_checks: check ? [{ check, code, message }] : [],
    checks_passed: [],
    checks_skipped: [],
    policy_version: policyVersion,
    evaluated_at: evaluatedAt,
    payment: null,
  };
}

function bestEffortVersion(input: unknown): number | null {
  try {
    const v = (input as { policy?: { version?: unknown } } | null | undefined)?.policy?.version;
    return typeof v === "number" && Number.isInteger(v) ? v : null;
  } catch {
    return null; // a throwing getter must not escape; the main path reports INTERNAL_ERROR
  }
}

/**
 * Evaluate every eligibility check of spec 6.3 in order and return one structured decision.
 * Pure and deterministic: no I/O, no clock, no randomness. Never throws; any problem blocks.
 * All checks run so `failed_checks` lists everything wrong; the first failure is the primary decision.
 */
export function evaluatePolicy(input: unknown): PolicyDecision {
  const version = bestEffortVersion(input);
  try {
    const parsed = PolicyEvaluationRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? issue.path.join(".") || "(root)" : "(unknown)";
      return blocked("INVALID_REQUEST", `The evaluation request is invalid at ${where}.`, version, null);
    }
    const req = parsed.data;
    const nowMs = parseInstant(req.now);
    if (nowMs === null) return blocked("INVALID_REQUEST", "The evaluation time is invalid.", req.policy.version, null);
    let today: string;
    try {
      today = businessDate(nowMs, req.business.timezone);
    } catch {
      return blocked("INVALID_REQUEST", "The business timezone is not a valid IANA timezone.", req.policy.version, req.now);
    }

    const ctx: Ctx = {
      req,
      nowMs,
      today,
      amount: parseMoney(req.invoice.amount, false),
      balance: parseMoney(req.balances.rlusd_balance, true),
      maxPayment: new Dec(req.policy.max_payment_amount),
      dailyLimit: new Dec(req.policy.daily_spend_limit),
      minReserve: new Dec(req.policy.minimum_reserve),
    };

    const failedChecks: CheckFailure[] = [];
    const passed: CheckId[] = [];
    const skipped: CheckId[] = [];
    for (const id of CHECK_IDS) {
      const out = CHECKS[id](ctx);
      if (out.kind === "pass") passed.push(id);
      else if (out.kind === "skip") skipped.push(id);
      else failedChecks.push(out.details ? { check: id, code: out.code, message: out.message, details: out.details } : { check: id, code: out.code, message: out.message });
    }

    const first = failedChecks[0];
    if (first || ctx.amount === null) {
      // ctx.amount === null always has a failed amount_valid, so `first` exists; the guard keeps the types honest.
      const f = first ?? { check: "amount_valid" as const, code: "INVALID_AMOUNT" as const, message: "Invalid amount." };
      return {
        allowed: false,
        decision_code: f.code,
        failure_code: f.code,
        message: f.message,
        failed_check: f.check,
        failed_checks: failedChecks,
        checks_passed: passed,
        checks_skipped: skipped,
        policy_version: req.policy.version,
        evaluated_at: req.now,
        payment: null,
      };
    }

    return {
      allowed: true,
      decision_code: "ALLOWED",
      failure_code: null,
      message: `Payment allowed by policy version ${req.policy.version}.`,
      failed_check: null,
      failed_checks: [],
      checks_passed: passed,
      checks_skipped: skipped,
      policy_version: req.policy.version,
      evaluated_at: req.now,
      payment: {
        invoice_id: req.invoice.id,
        supplier_id: req.supplier.id,
        wallet_id: req.wallet.id,
        amount: String(req.invoice.amount),
        currency: req.config.rlusd_display_symbol,
        asset: { currency: req.config.rlusd_currency_hex, issuer: req.config.rlusd_issuer },
        destination: req.supplier.xrpl_address,
        network: req.config.network,
        business_date: today,
      },
    };
  } catch {
    return blocked("INTERNAL_ERROR", "The policy engine failed unexpectedly, so the payment is blocked.", version, null);
  }
}

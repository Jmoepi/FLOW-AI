import {
  redactValue, sanitizeText, type AgentRunCreate, type AgentRunEvent, type AgentRunFinish,
} from "@flow-ai/contracts";
import {
  DbError, appendAgentRunEvent, appendAudit, createAgentRun, finishAgentRun, getInvoice, getRunningAgentRunId, interruptAgentRun, listAgentRunPaymentRequests,
  lockAgentRun, lockStaleRunningRuns, recordAgentRunPaymentRequest, withTransaction, type AgentRunPaymentRequestRow, type AgentRunTerminalStatus, type PoolClient,
} from "@flow-ai/database";
import { resolveAgentBusinessId } from "./agent-views";
import type { PaymentResult, ServiceDeps } from "./payments";

/** Audit actors for run records. The agent is untrusted; the guard writes these rows on its behalf. */
const AGENT_ACTOR = { actor_type: "agent", actor_id: "agent" } as const;
const SYSTEM = { actor_type: "system", actor_id: "payment-guard" } as const;
export const INTERRUPTED_SUMMARY = "Run did not finish; marked interrupted by the guard.";
const MAX_JSON_BYTES = 4096;

export type RunOutcome<T> = { kind: "ok"; value: T } | { kind: "not_found" } | { kind: "conflict"; code: "RUN_IN_PROGRESS" | "RUN_NOT_RUNNING" } | { kind: "invalid" };

/** POST /internal/agent-runs. The unique running-run index is the lock: a second concurrent run gets RUN_IN_PROGRESS. */
export async function startAgentRun(deps: ServiceDeps, businessId: string, body: AgentRunCreate, requestId: string): Promise<RunOutcome<{ run_id: string; started_at: string }>> {
  try {
    const run = await withTransaction(deps.pool, async (c) => {
      const created = await createAgentRun(c, { business_id: businessId, trigger: body.trigger, mode: body.mode });
      await appendAudit(c, {
        business_id: businessId, ...AGENT_ACTOR, event_type: "agent.run_started", entity_type: "agent_run", entity_id: created.id,
        metadata: { mode: body.mode, trigger: body.trigger }, request_id: requestId,
      });
      return created;
    });
    return { kind: "ok", value: { run_id: run.id, started_at: run.started_at } };
  } catch (err) {
    if (err instanceof DbError && err.code === "UNIQUE_VIOLATION") return { kind: "conflict", code: "RUN_IN_PROGRESS" };
    throw err;
  }
}

/** Re-redacts and size-checks a model-influenced JSON object on the guard side. Returns undefined when absent, null when too big. */
function cleanJson(v: Record<string, unknown> | undefined): Record<string, unknown> | undefined | null {
  if (v === undefined) return undefined;
  const redacted = redactValue(v);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) return null;
  return Buffer.byteLength(JSON.stringify(redacted), "utf8") <= MAX_JSON_BYTES ? (redacted as Record<string, unknown>) : null;
}

/** POST /internal/agent-runs/:id/events. Append-only; 32 events at most; not allowed once the run is finished. */
export async function appendRunEvent(deps: ServiceDeps, businessId: string, runId: string, ev: AgentRunEvent): Promise<RunOutcome<{ seq: number }>> {
  const input = cleanJson(ev.input);
  const output = cleanJson(ev.output);
  if (input === null || output === null) return { kind: "invalid" };
  try {
    const res = await withTransaction(deps.pool, (c) =>
      appendAgentRunEvent(c, runId, businessId, {
        kind: ev.kind, tool_name: ev.tool_name, ok: ev.ok, error_code: ev.error_code, duration_ms: ev.duration_ms, input, output,
      }),
    );
    return res === null ? { kind: "not_found" } : { kind: "ok", value: res };
  } catch (err) {
    if (err instanceof DbError && err.code === "STATE_VIOLATION") return { kind: "conflict", code: "RUN_NOT_RUNNING" };
    throw err;
  }
}

async function ownsInvoice(c: PoolClient, businessId: string, invoiceId: string): Promise<boolean> {
  return (await getInvoice(c, invoiceId))?.business_id === businessId;
}
/** Run status a stored payment status maps to. Only a validated payment is `paid`. */
const PAYMENT_TO_RUN_STATUS: Record<string, AgentRunTerminalStatus> = {
  validated: "paid",
  failed: "failed",
  cancelled: "failed",
  blocked: "blocked",
  requested: "pending",
  reserved: "pending",
  submitted: "pending",
  pending_confirmation: "pending",
};
export interface DerivedRunOutcome {
  status: AgentRunTerminalStatus;
  payment_id: string | null;
  invoice_id: string | null;
  decision_code: string | null;
}
/**
 * The run outcome, derived ONLY from what the guard recorded (never from the agent's claim). With payment requests on
 * record the outcome is the current state of the latest request's payment (or the decision the guard observed when no
 * payment row exists). Without any, a claim of paid/pending/blocked cannot be true and becomes `failed`; the claims
 * that assert no payment activity (no_candidate, failed, timed_out, limit_exceeded) are kept because they move no money.
 */
export function deriveRunOutcome(requests: readonly AgentRunPaymentRequestRow[], clientStatus: AgentRunTerminalStatus): DerivedRunOutcome {
  const last = requests[requests.length - 1];
  if (last !== undefined) {
    const effective = last.payment_id === null ? last.observed_status : (last.payment_status ?? last.observed_status);
    const status = PAYMENT_TO_RUN_STATUS[effective] ?? "failed";
    const code = status === "blocked" ? (last.payment_failure_code ?? last.observed_decision_code) : last.observed_decision_code;
    return { status, payment_id: last.payment_id, invoice_id: last.invoice_id, decision_code: code };
  }
  const claimsPayment = clientStatus === "paid" || clientStatus === "pending" || clientStatus === "blocked";
  return { status: claimsPayment ? "failed" : clientStatus, payment_id: null, invoice_id: null, decision_code: null };
}
/**
 * Called by the payment-request route before execution. If a run is running for the business, records what the guard
 * is about to answer. Fails closed: if the record cannot be stored the request fails and a reserved payment is
 * cancelled by the stale-reservation sweeper. Replays of the same key are no-ops.
 */
export async function recordRunPaymentRequest(deps: ServiceDeps, input: { invoice_id: string; idempotency_key: string }, result: PaymentResult): Promise<void> {
  const businessId = await resolveAgentBusinessId(deps);
  if (businessId === null) return;
  await withTransaction(deps.pool, async (c) => {
    const runId = await getRunningAgentRunId(c, businessId);
    if (runId === null || !(await ownsInvoice(c, businessId, input.invoice_id))) return;
    const code = result.body.policy_decision.decision_code;
    await recordAgentRunPaymentRequest(c, runId, businessId, {
      invoice_id: input.invoice_id,
      idempotency_key: input.idempotency_key,
      payment_id: result.body.payment_id,
      observed_status: result.body.status,
      observed_decision_code: /^[A-Z_]{1,64}$/.test(code) ? code : null,
    });
  });
}
/**
 * POST /internal/agent-runs/:id/finish. One terminal transition, exactly once (a second finish is RUN_NOT_RUNNING).
 * The stored status, payment and decision are derived from the guard's records; the agent's status is only kept as
 * client_status. A payment id the run did not request itself is rejected before anything changes.
 */
export async function finishRun(deps: ServiceDeps, businessId: string, runId: string, body: AgentRunFinish, requestId: string): Promise<RunOutcome<{ status: string }>> {
  return withTransaction(deps.pool, async (c): Promise<RunOutcome<{ status: string }>> => {
    const run = await lockAgentRun(c, runId, businessId);
    if (!run) return { kind: "not_found" };
    if (run.status !== "running") return { kind: "conflict", code: "RUN_NOT_RUNNING" };
    const requests = await listAgentRunPaymentRequests(c, runId, businessId);
    if (body.payment_id !== undefined && !requests.some((r) => r.payment_id === body.payment_id)) return { kind: "invalid" };
    if (body.candidate_invoice_id !== undefined && !(await ownsInvoice(c, businessId, body.candidate_invoice_id))) return { kind: "invalid" };
    const derived = deriveRunOutcome(requests, body.client_status);
    const reason = body.agent_reason === undefined ? undefined : sanitizeText(body.agent_reason, 280).trim();
    const done = await finishAgentRun(c, runId, businessId, {
      status: derived.status, client_status: body.client_status, summary: sanitizeText(body.summary, 500), tool_call_count: body.tool_call_count,
      candidate_invoice_id: derived.invoice_id ?? body.candidate_invoice_id, payment_id: derived.payment_id ?? undefined,
      decision_code: derived.decision_code ?? undefined, agent_reason: reason === "" ? undefined : reason, effective_mode: body.effective_mode,
    });
    if (!done) return { kind: "conflict", code: "RUN_NOT_RUNNING" };
    await appendAudit(c, {
      business_id: businessId, ...AGENT_ACTOR, event_type: "agent.run_finished", entity_type: "agent_run", entity_id: runId,
      metadata: {
        status: derived.status, client_status: body.client_status, decision_code: derived.decision_code, payment_id: derived.payment_id,
        tool_call_count: body.tool_call_count,
      },
      request_id: requestId,
    });
    return { kind: "ok", value: { status: done.status } };
  });
}
/**
 * Marks running runs with no activity for AGENT_RUN_STALE_SECONDS as interrupted (the agent crashed or hung). Locked rows
 * are skipped by other sweepers, and a late finish from the dead agent then gets RUN_NOT_RUNNING.
 */
export async function sweepStaleAgentRuns(deps: ServiceDeps): Promise<number> {
  return withTransaction(deps.pool, async (c) => {
    const stale = await lockStaleRunningRuns(c, deps.config.agentRunStaleSeconds, 50);
    let interrupted = 0;
    for (const run of stale) {
      // An interrupted run keeps a pointer to the payment it requested (if any) so the owner can look at its real state.
      const last = (await listAgentRunPaymentRequests(c, run.id, run.business_id)).pop();
      const done = await interruptAgentRun(c, run, INTERRUPTED_SUMMARY, last === undefined ? undefined : { payment_id: last.payment_id ?? undefined, candidate_invoice_id: last.invoice_id });
      if (!done) continue;
      interrupted++;
      await appendAudit(c, {
        business_id: run.business_id, ...SYSTEM, event_type: "agent.run_interrupted", entity_type: "agent_run", entity_id: run.id,
        metadata: { status: "interrupted", tool_call_count: done.tool_call_count },
      });
    }
    if (interrupted > 0) deps.logger.info("sweeper.agent_runs_interrupted", { count: interrupted });
    return interrupted;
  });
}

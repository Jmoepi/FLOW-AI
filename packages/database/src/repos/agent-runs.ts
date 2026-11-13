import { DbError } from "../errors";
import { iso, isoOrNull, run, runOne, uuid, type Queryable } from "../db";

export type AgentRunMode = "llm" | "deterministic";
export type AgentRunTrigger = "manual" | "interval";
export type AgentRunStatusValue =
  | "running" | "paid" | "pending" | "blocked" | "no_candidate" | "failed" | "timed_out" | "limit_exceeded" | "interrupted";
export type AgentRunTerminalStatus = Exclude<AgentRunStatusValue, "running">;
const TERMINAL: readonly string[] = ["paid", "pending", "blocked", "no_candidate", "failed", "timed_out", "limit_exceeded", "interrupted"];
const EVENT_KINDS: readonly string[] = ["tool_call", "decision", "model_turn", "mode_fallback", "note"];
const TOOL_NAMES: readonly string[] = ["get_business_snapshot", "list_open_invoices", "get_invoice_details", "request_supplier_payment", "get_payment_status"];
const CODE_RE = /^[A-Z_]{1,64}$/;
const MAX_EVENTS = 32;

export interface AgentRunRow {
  id: string;
  business_id: string;
  seq: number;
  status: AgentRunStatusValue;
  trigger: AgentRunTrigger;
  mode: AgentRunMode;
  effective_mode: AgentRunMode | null;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  tool_call_count: number;
  candidate_invoice_id: string | null;
  payment_id: string | null;
  decision_code: string | null;
  agent_reason: string | null;
  /** UNTRUSTED hint reported by the agent. `status` is derived by the guard and is the only outcome ever displayed. */
  client_status: AgentRunTerminalStatus | null;
  last_activity_at: string;
}

interface RunDbRow extends Omit<AgentRunRow, "seq" | "started_at" | "completed_at" | "last_activity_at"> {
  seq: string;
  started_at: unknown;
  completed_at: unknown;
  last_activity_at: unknown;
}

const RUN_COLS = `id, business_id, seq::text AS seq, status, trigger, mode, effective_mode, started_at, completed_at, summary, tool_call_count,
       candidate_invoice_id, payment_id, decision_code, agent_reason, client_status, last_activity_at`;

function mapRun(r: RunDbRow): AgentRunRow {
  return { ...r, seq: Number(r.seq), started_at: iso(r.started_at), completed_at: isoOrNull(r.completed_at), last_activity_at: iso(r.last_activity_at) };
}

/** Starts a run. A second `running` run for the same business violates the partial unique index (the guard-side lock). */
export async function createAgentRun(q: Queryable, r: { business_id: string; trigger: AgentRunTrigger; mode: AgentRunMode }): Promise<AgentRunRow> {
  if (!["manual", "interval"].includes(r.trigger) || !["llm", "deterministic"].includes(r.mode)) throw new DbError("INVALID_INPUT");
  const row = await runOne<RunDbRow>(
    q,
    `INSERT INTO agent_runs (business_id, status, trigger, mode) VALUES ($1, 'running', $2, $3) RETURNING ${RUN_COLS}`,
    [uuid(r.business_id), r.trigger, r.mode],
  );
  if (!row) throw new DbError("DB_ERROR");
  return mapRun(row);
}

export async function getAgentRun(q: Queryable, id: string, businessId?: string): Promise<AgentRunRow | null> {
  const row = await runOne<RunDbRow>(
    q,
    `SELECT ${RUN_COLS} FROM agent_runs WHERE id = $1 AND ($2::uuid IS NULL OR business_id = $2)`,
    [uuid(id), businessId === undefined ? null : uuid(businessId)],
  );
  return row ? mapRun(row) : null;
}

/** Locks the run row. Must be called inside a transaction. */
export async function lockAgentRun(q: Queryable, id: string, businessId: string): Promise<AgentRunRow | null> {
  const row = await runOne<RunDbRow>(q, `SELECT ${RUN_COLS} FROM agent_runs WHERE id = $1 AND business_id = $2 FOR UPDATE`, [uuid(id), uuid(businessId)]);
  return row ? mapRun(row) : null;
}

export interface NewAgentRunEvent {
  kind: string;
  tool_name?: string | undefined;
  ok?: boolean | undefined;
  error_code?: string | undefined;
  duration_ms?: number | undefined;
  /** Already redacted and size-checked by the caller. */
  input?: Record<string, unknown> | undefined;
  output?: Record<string, unknown> | undefined;
}

/**
 * Appends the next event. Call inside a transaction: the run row is locked first, so concurrent appends and a finish are
 * serialised. Returns null when the run is not this business's. A finished run or a 33rd event raises STATE_VIOLATION.
 */
export async function appendAgentRunEvent(q: Queryable, runId: string, businessId: string, ev: NewAgentRunEvent): Promise<{ seq: number } | null> {
  if (!EVENT_KINDS.includes(ev.kind)) throw new DbError("INVALID_INPUT");
  if (ev.tool_name !== undefined && !TOOL_NAMES.includes(ev.tool_name)) throw new DbError("INVALID_INPUT");
  if (ev.error_code !== undefined && !CODE_RE.test(ev.error_code)) throw new DbError("INVALID_INPUT");
  const run_ = await lockAgentRun(q, runId, businessId);
  if (!run_) return null;
  if (run_.status !== "running") throw new DbError("STATE_VIOLATION");
  const last = await runOne<{ n: number }>(q, "SELECT COALESCE(max(seq), 0)::int AS n FROM agent_run_events WHERE run_id = $1", [run_.id]);
  const next = (last?.n ?? 0) + 1;
  if (next > MAX_EVENTS) throw new DbError("STATE_VIOLATION");
  await run(
    q,
    `INSERT INTO agent_run_events (run_id, business_id, seq, kind, tool_name, ok, error_code, duration_ms, input, output)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [
      run_.id, run_.business_id, next, ev.kind, ev.tool_name ?? null, ev.ok ?? null, ev.error_code ?? null, ev.duration_ms ?? null,
      ev.input === undefined ? null : JSON.stringify(ev.input), ev.output === undefined ? null : JSON.stringify(ev.output),
    ],
  );
  await run(q, "UPDATE agent_runs SET last_activity_at = clock_timestamp() WHERE id = $1", [run_.id]);
  return { seq: next };
}

export interface AgentRunFinishPatch {
  status: AgentRunTerminalStatus;
  summary: string;
  tool_call_count: number;
  candidate_invoice_id?: string | undefined;
  payment_id?: string | undefined;
  decision_code?: string | undefined;
  /** Already control-stripped and at most 280 characters. */
  agent_reason?: string | undefined;
  effective_mode?: AgentRunMode | undefined;
  /** What the agent claimed. Stored apart from `status`; never displayed as the outcome. */
  client_status?: AgentRunTerminalStatus | undefined;
}

/** Moves a running run to a terminal state. Returns null if it is not running (already finished) or not found. */
export async function finishAgentRun(q: Queryable, runId: string, businessId: string, p: AgentRunFinishPatch): Promise<AgentRunRow | null> {
  if (!TERMINAL.includes(p.status) || (p.client_status !== undefined && !TERMINAL.includes(p.client_status))) throw new DbError("INVALID_INPUT");
  if (!Number.isInteger(p.tool_call_count) || p.tool_call_count < 0 || p.tool_call_count > 5) throw new DbError("INVALID_INPUT");
  if (p.decision_code !== undefined && !CODE_RE.test(p.decision_code)) throw new DbError("INVALID_INPUT");
  if (p.agent_reason !== undefined && p.agent_reason.length > 280) throw new DbError("INVALID_INPUT");
  if (p.summary.length > 500) throw new DbError("INVALID_INPUT");
  const row = await runOne<RunDbRow>(
    q,
    `UPDATE agent_runs SET status = $3, summary = $4, tool_call_count = $5, candidate_invoice_id = $6, payment_id = $7,
            decision_code = $8, agent_reason = $9, effective_mode = $10, client_status = $11, completed_at = clock_timestamp(), last_activity_at = clock_timestamp()
      WHERE id = $1 AND business_id = $2 AND status = 'running' RETURNING ${RUN_COLS}`,
    [
      uuid(runId), uuid(businessId), p.status, p.summary, p.tool_call_count,
      p.candidate_invoice_id === undefined ? null : uuid(p.candidate_invoice_id), p.payment_id === undefined ? null : uuid(p.payment_id),
      p.decision_code ?? null, p.agent_reason ?? null, p.effective_mode ?? null, p.client_status ?? null,
    ],
  );
  return row ? mapRun(row) : null;
}

/** Sweeper candidates: running runs with no activity for `olderThanSeconds`. Rows are locked; other sweepers skip them. */
export async function lockStaleRunningRuns(q: Queryable, olderThanSeconds: number, limit: number): Promise<AgentRunRow[]> {
  if (!Number.isInteger(olderThanSeconds) || olderThanSeconds < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new DbError("INVALID_INPUT");
  const rows = await run<RunDbRow>(
    q,
    `SELECT ${RUN_COLS} FROM agent_runs
      WHERE status = 'running' AND last_activity_at < now() - make_interval(secs => $1)
      ORDER BY last_activity_at, id FOR UPDATE SKIP LOCKED LIMIT $2`,
    [olderThanSeconds, limit],
  );
  return rows.map(mapRun);
}

/** Marks a locked stale run interrupted, keeping the tool call count recorded so far (the number of events). */
export async function interruptAgentRun(
  q: Queryable, run_: AgentRunRow, summary: string, link?: { payment_id?: string | undefined; candidate_invoice_id?: string | undefined },
): Promise<AgentRunRow | null> {
  const counted = await runOne<{ n: number }>(
    q,
    "SELECT count(*)::int AS n FROM agent_run_events WHERE run_id = $1 AND kind = 'tool_call'",
    [uuid(run_.id)],
  );
  return finishAgentRun(q, run_.id, run_.business_id, {
    status: "interrupted", summary, tool_call_count: Math.min(5, counted?.n ?? 0), payment_id: link?.payment_id, candidate_invoice_id: link?.candidate_invoice_id,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Guard-observed payment requests (the basis for the derived run outcome)
// ---------------------------------------------------------------------------------------------------------------------
export interface AgentRunPaymentRequestRow {
  id: string;
  run_id: string;
  business_id: string;
  invoice_id: string;
  idempotency_key: string;
  payment_id: string | null;
  observed_status: string;
  observed_decision_code: string | null;
  /** Current status of the linked payment (read live from payments), null when no payment row exists. */
  payment_status: string | null;
  payment_failure_code: string | null;
  created_at: string;
}
export interface NewAgentRunPaymentRequest {
  invoice_id: string;
  idempotency_key: string;
  payment_id: string | null;
  observed_status: string;
  observed_decision_code: string | null;
}
/** The business's currently running run, if any. */
export async function getRunningAgentRunId(q: Queryable, businessId: string): Promise<string | null> {
  const row = await runOne<{ id: string }>(q, "SELECT id FROM agent_runs WHERE business_id = $1 AND status = 'running' LIMIT 1", [uuid(businessId)]);
  return row?.id ?? null;
}
/** Records a payment request the guard served during a run. Replays of the same key are no-ops. Returns whether a row was added. */
export async function recordAgentRunPaymentRequest(q: Queryable, runId: string, businessId: string, r: NewAgentRunPaymentRequest): Promise<boolean> {
  const rows = await run(
    q,
    `INSERT INTO agent_run_payment_requests (run_id, business_id, invoice_id, idempotency_key, payment_id, observed_status, observed_decision_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (run_id, idempotency_key) DO NOTHING RETURNING id`,
    [uuid(runId), uuid(businessId), uuid(r.invoice_id), r.idempotency_key, r.payment_id === null ? null : uuid(r.payment_id), r.observed_status, r.observed_decision_code],
  );
  return rows.length > 0;
}
/** The run's recorded payment requests, oldest first, with the linked payment's live status. */
export async function listAgentRunPaymentRequests(q: Queryable, runId: string, businessId: string): Promise<AgentRunPaymentRequestRow[]> {
  const rows = await run<Omit<AgentRunPaymentRequestRow, "created_at"> & { created_at: unknown }>(
    q,
    `SELECT q.id, q.run_id, q.business_id, q.invoice_id, q.idempotency_key, q.payment_id, q.observed_status, q.observed_decision_code,
            p.status AS payment_status, p.failure_code AS payment_failure_code, q.created_at
       FROM agent_run_payment_requests q
       LEFT JOIN payments p ON p.id = q.payment_id AND p.business_id = q.business_id
      WHERE q.run_id = $1 AND q.business_id = $2 ORDER BY q.created_at, q.id`,
    [uuid(runId), uuid(businessId)],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}
// ---------------------------------------------------------------------------------------------------------------------
// Owner web reads (role flow_web, tenant-scoped by RLS and by the explicit business id)
// ---------------------------------------------------------------------------------------------------------------------
export interface WebAgentRunRow extends AgentRunRow {
  candidate_invoice_number: string | null;
  payment_status: string | null;
  payment_tx_hash: string | null;
}

interface WebRunDbRow extends RunDbRow {
  candidate_invoice_number: string | null;
  payment_status: string | null;
  payment_tx_hash: string | null;
}

/** Newest first, keyset paged by seq. Whitelisted columns only; the limit is bounded. */
export async function listAgentRunsForBusiness(q: Queryable, businessId: string, opts: { limit?: number; beforeSeq?: number } = {}): Promise<WebAgentRunRow[]> {
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DbError("INVALID_INPUT");
  const before = opts.beforeSeq ?? null;
  if (before !== null && (!Number.isInteger(before) || before < 1 || before > Number.MAX_SAFE_INTEGER)) throw new DbError("INVALID_INPUT");
  const rows = await run<WebRunDbRow>(
    q,
    `SELECT r.id, r.business_id, r.seq::text AS seq, r.status, r.trigger, r.mode, r.effective_mode, r.started_at, r.completed_at, r.summary,
            r.tool_call_count, r.candidate_invoice_id, r.payment_id, r.decision_code, r.agent_reason, r.client_status, r.last_activity_at,
            i.invoice_number AS candidate_invoice_number, p.status AS payment_status, p.tx_hash AS payment_tx_hash
       FROM agent_runs r
       LEFT JOIN invoices i ON i.id = r.candidate_invoice_id AND i.business_id = r.business_id
       LEFT JOIN payments p ON p.id = r.payment_id AND p.business_id = r.business_id
      WHERE r.business_id = $1 AND ($2::bigint IS NULL OR r.seq < $2::bigint)
      ORDER BY r.seq DESC LIMIT $3`,
    [uuid(businessId), before, limit],
  );
  return rows.map((r) => ({ ...mapRun(r), candidate_invoice_number: r.candidate_invoice_number, payment_status: r.payment_status, payment_tx_hash: r.payment_tx_hash }));
}

export interface WebAgentRunEventRow {
  run_id: string;
  seq: number;
  kind: string;
  tool_name: string | null;
  ok: boolean | null;
  error_code: string | null;
  duration_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  created_at: string;
}

/** Events for a bounded set of runs of this business. */
export async function listAgentRunEvents(q: Queryable, businessId: string, runIds: readonly string[]): Promise<WebAgentRunEventRow[]> {
  if (runIds.length === 0) return [];
  if (runIds.length > 50) throw new DbError("INVALID_INPUT");
  const rows = await run<Omit<WebAgentRunEventRow, "created_at"> & { created_at: unknown }>(
    q,
    `SELECT run_id, seq, kind, tool_name, ok, error_code, duration_ms, input, output, created_at
       FROM agent_run_events WHERE business_id = $1 AND run_id = ANY($2::uuid[]) ORDER BY run_id, seq`,
    [uuid(businessId), runIds.map(uuid)],
  );
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

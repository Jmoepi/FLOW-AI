import { redactError, sanitizeText, type AgentRunFinish, type AgentRunEvent, type AgentToolName } from "@flow-ai/contracts";
import { GuardError } from "../guard/client";
import { createLogger } from "../logger";
import type { ToolCallResult } from "../mcp/mcp-client";
import type { Brain, BrainContext, BrainOutcome, RunAgentOptions, RunResult } from "./types";

/** Per-tool caps (Decision: reads 10 s; the payment waits for guard-side validation, up to 55 s). */
export const READ_TIMEOUT_MS = 10_000;
export const PAYMENT_TIMEOUT_MS = 55_000;

/** Small, text-free projection of a tool result for the run record (ids, codes, amounts, counts only). */
export function projectResult(name: AgentToolName, res: ToolCallResult): Record<string, unknown> {
  if (!res.ok) return { ok: false, code: res.error?.code ?? "INTERNAL" };
  const d = res.data;
  switch (name) {
    case "get_business_snapshot":
      return { rlusd_balance: d.rlusd_balance, minimum_reserve: d.minimum_reserve, daily_remaining: d.daily_remaining, automation: d.automation, stale: d.stale };
    case "list_open_invoices": {
      const list = Array.isArray(d.invoices) ? (d.invoices as Record<string, unknown>[]) : [];
      return {
        count: d.count,
        invoices: list.slice(0, 10).map((i) => ({ invoice_id: i.invoice_id, due_date: i.due_date, amount: i.amount, eligible: (i.eligibility as { eligible?: unknown } | undefined)?.eligible })),
      };
    }
    case "get_invoice_details": {
      const inv = (d.invoice ?? {}) as { invoice_id?: unknown; eligibility?: { eligible?: unknown; failed_checks?: unknown } };
      return { invoice_id: inv.invoice_id, eligible: inv.eligibility?.eligible, failed_checks: inv.eligibility?.failed_checks };
    }
    case "request_supplier_payment":
      return { payment_id: d.payment_id, status: d.status, decision_code: d.decision_code, failure_code: d.failure_code, amount: d.amount, tx_hash: d.tx_hash };
    case "get_payment_status": {
      const list = Array.isArray(d.payments) ? (d.payments as Record<string, unknown>[]) : [];
      return { count: list.length, payments: list.slice(0, 5).map((p) => ({ payment_id: p.payment_id, status: p.status, tx_hash: p.tx_hash })) };
    }
  }
}

function projectInput(name: AgentToolName, args: Record<string, unknown>): Record<string, unknown> {
  // Only the fields the tool accepts; the free-text reason is recorded by the intent event, not repeated here.
  if (name === "request_supplier_payment") return { invoice_id: args.invoice_id, idempotency_key: args.idempotency_key };
  return { ...args };
}


/**
 * Runs one bounded agent run: creates the run record (or exits `skipped` on 409), hands a context to the brain,
 * and ALWAYS finishes the record. The guard stays the only decision maker; this loop only sequences tool calls.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { config, recorder, tools, brain, trigger } = opts;
  const log = opts.logger ?? createLogger();
  const probeIneligible = opts.probeIneligible ?? false;
  const base = {
    mode: brain.mode,
    effectiveMode: brain.mode,
    trigger,
    candidateInvoiceId: null,
    paymentId: null,
    txHash: null,
    explorerUrl: null,
    decisionCode: null,
    agentReason: null,
  } as const;

  let runId: string;
  try {
    runId = await recorder.start(trigger, brain.mode);
  } catch (err) {
    if (err instanceof GuardError && err.status === 409) {
      log.info("run.skipped", { reason: "RUN_IN_PROGRESS" });
      return { ...base, status: "skipped", summary: "Another agent run is already in progress. This run was skipped.", runId: null, toolCallCount: 0, events: [] };
    }
    log.error("run.start_failed", { error: redactError(err) });
    return { ...base, status: "failed", summary: "The run could not be recorded, so it did not start.", runId: null, toolCallCount: 0, events: [] };
  }

  const deadline = Date.now() + config.runTimeoutSeconds * 1000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.runTimeoutSeconds * 1000);
  const onExternalAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (opts.signal?.aborted === true) controller.abort();

  let calls = 0;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

  const ctx: BrainContext = {
    runId,
    config,
    recorder,
    logger: log,
    signal: controller.signal,
    probeIneligible,
    remainingMs,
    toolCallCount: () => calls,
    async callTool(name, args) {
      const started = Date.now();
      let result: ToolCallResult;
      if (calls >= config.maxToolCalls) {
        result = { ok: false, data: {}, error: { code: "TOOL_CALL_LIMIT", message: "Tool call limit reached for this run." } };
      } else if (controller.signal.aborted || remainingMs() <= 0) {
        result = { ok: false, data: {}, error: { code: "RUN_TIMEOUT", message: "The run time budget is used up." } };
      } else {
        calls += 1;
        const cap = name === "request_supplier_payment" ? PAYMENT_TIMEOUT_MS : READ_TIMEOUT_MS;
        try {
          result = await tools.call(name, args, { timeoutMs: Math.min(remainingMs(), cap), signal: controller.signal });
        } catch (err) {
          const aborted = controller.signal.aborted;
          log.warn("run.tool_error", { tool: name, error: redactError(err) });
          result = {
            ok: false,
            data: {},
            error: aborted ? { code: "RUN_TIMEOUT", message: "The run was cancelled or timed out." } : { code: "GUARD_TIMEOUT", message: "The tool did not answer in time." },
          };
        }
      }
      const ev: AgentRunEvent = {
        kind: "tool_call",
        tool_name: name,
        input: projectInput(name, args),
        output: projectResult(name, result),
        ok: result.ok,
        duration_ms: Date.now() - started,
        ...(result.ok || result.error === undefined ? {} : { error_code: result.error.code }),
      };
      await recorder.event(ev);
      return result;
    },
  };

  let outcome: BrainOutcome;
  let effectiveMode = brain.mode;
  try {
    outcome = await brain.run(ctx);
    effectiveMode = outcome.effectiveMode ?? brain.mode;
  } catch (err) {
    log.error("run.crashed", { error: redactError(err) });
    outcome = timedOut
      ? { status: "timed_out", summary: "The run exceeded its time limit. Check the payment status before retrying." }
      : { status: "failed", summary: "The run stopped on an internal error. No further tool calls were made." };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }

  const summary = sanitizeText(outcome.summary, 500);
  const patch: AgentRunFinish = {
    // A hint only: the guard derives the stored outcome from its own records.
    client_status: outcome.status,
    summary,
    tool_call_count: Math.min(calls, 5),
    effective_mode: effectiveMode,
    ...(outcome.candidateInvoiceId === undefined ? {} : { candidate_invoice_id: outcome.candidateInvoiceId }),
    ...(outcome.paymentId === undefined ? {} : { payment_id: outcome.paymentId }),
    ...(outcome.agentReason === undefined ? {} : { agent_reason: outcome.agentReason }),
  };
  const finished = await recorder.finish(patch);
  if (!finished) log.error("run.finish_unconfirmed", { run_id: runId });

  return {
    ...base,
    effectiveMode,
    status: outcome.status,
    summary,
    runId,
    toolCallCount: calls,
    candidateInvoiceId: outcome.candidateInvoiceId ?? null,
    paymentId: outcome.paymentId ?? null,
    txHash: outcome.txHash ?? null,
    explorerUrl: outcome.explorerUrl ?? null,
    decisionCode: outcome.decisionCode ?? null,
    agentReason: outcome.agentReason ?? null,
    events: recorder.events(),
  };
}

export type { Brain };

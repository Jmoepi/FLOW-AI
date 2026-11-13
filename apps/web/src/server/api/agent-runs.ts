import { AgentRunsQuerySchema, redactValue } from "@flow-ai/contracts";
import { appendAudit, createAgentRunRequest, DbError, listAgentRunEvents, listAgentRunsForBusiness, withWebTx } from "@flow-ai/database";
import { explorerUrl } from "../../components/explorer";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const PAGE = 20;
export { explorerUrl };
/** Read-only, newest first. Event payloads are re-redacted on the way out; free text is rendered as text by the page. */
export const agentRunsListRoute = defineRoute({
  method: "GET",
  path: "/api/agent-runs",
  role: "owner",
  query: AgentRunsQuerySchema,
  handler: async ({ deps, session, query }) => {
    const limit = query.limit ?? PAGE;
    const { rows, events } = await withWebTx(deps.pool, session.businessId, async (c) => {
      const r = await listAgentRunsForBusiness(c, session.businessId, { limit, ...(query.before_seq === undefined ? {} : { beforeSeq: query.before_seq }) });
      return { rows: r, events: await listAgentRunEvents(c, session.businessId, r.map((x) => x.id)) };
    });
    const runs = rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      started_at: r.started_at,
      completed_at: r.completed_at,
      status: r.status,
      trigger: r.trigger,
      mode: r.mode,
      effective_mode: r.effective_mode,
      summary: r.summary,
      tool_call_count: r.tool_call_count,
      decision_code: r.decision_code,
      agent_reason: r.agent_reason,
      invoice_number: r.candidate_invoice_number,
      payment:
        r.payment_id === null
          ? null
          : { id: r.payment_id, status: r.payment_status, tx_hash: r.payment_tx_hash, explorer_url: explorerUrl(r.payment_status, r.payment_tx_hash) },
      events: events
        .filter((e) => e.run_id === r.id)
        .map((e) => ({
          seq: e.seq,
          kind: e.kind,
          tool_name: e.tool_name,
          ok: e.ok,
          error_code: e.error_code,
          duration_ms: e.duration_ms,
          input: redactValue(e.input),
          output: redactValue(e.output),
        })),
    }));
    const last = rows[rows.length - 1];
    return jsonResponse(200, { runs, next_before_seq: rows.length === limit && last !== undefined ? last.seq : null });
  },
});
/**
 * POST /api/agent-runs. The web process never holds the agent token, so the owner's button only records a request; the
 * agent claims it through the payment guard and runs under the same rules as any other run. One open request per business.
 */
export const agentRunRequestRoute = defineRoute({
  method: "POST",
  path: "/api/agent-runs",
  role: "owner",
  csrf: "token",
  handler: async ({ deps, requestId, session }) => {
    try {
      const created = await withWebTx(deps.pool, session.businessId, async (c) => {
        const r = await createAgentRunRequest(c, session.businessId, session.userId);
        await appendAudit(c, {
          business_id: session.businessId,
          actor_type: "human",
          actor_id: session.userId,
          event_type: "agent.run_requested",
          entity_type: "agent_run_request",
          entity_id: r.id,
          metadata: {},
          request_id: requestId,
        });
        return r;
      });
      deps.logger.info("agent.run_requested", { request_id: requestId });
      return jsonResponse(202, { status: "requested", request_id: created.id });
    } catch (err) {
      if (err instanceof DbError && err.code === "UNIQUE_VIOLATION") throw new HttpError(409, "RUN_REQUESTED", "A run is already requested and waiting for the agent.");
      throw err;
    }
  },
});

import { AgentRunsQuerySchema, redactValue } from "@flow-ai/contracts";
import { listAgentRunEvents, listAgentRunsForBusiness, withWebTx } from "@flow-ai/database";
import { jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
const PAGE = 20;
const TX_HASH = /^[0-9A-F]{64}$/;
/** The link is built only from a validated payment with a canonical 64-hex hash (IN-5); anything else yields no link. */
export function explorerUrl(status: string | null, txHash: string | null): string | null {
  return status === "validated" && txHash !== null && TX_HASH.test(txHash) ? `https://testnet.xrpl.org/transactions/${txHash}` : null;
}
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

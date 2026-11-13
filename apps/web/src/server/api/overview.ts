import { getBusinessForWeb, getLatestAgentRunRequest, getLatestDecisionCode, getOverviewData, getPolicyForWeb, listAgentRunsForBusiness, listInvoiceQueueForWeb, listPaymentsForWeb, withWebTx } from "@flow-ai/database";
import { Dec, businessDate, formatMoney } from "@flow-ai/policy-engine";
import { BALANCE_STALE_SECONDS } from "../../components/format";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
import { invoiceView } from "./invoices";
import { paymentView } from "./payments";
export type AutomationState = "paused" | "expired" | "needs_attention" | "active";
export type AgentState = "ready" | "running" | "paused" | "needs_attention";
const RUN_PROBLEMS = new Set(["failed", "timed_out", "interrupted"]);
const CODE = /^[A-Z_]{1,64}$/;
/** The four CFO answers (treasury, today's spend, remaining allowance, reserve) computed on the server with decimals. */
export const overviewRoute = defineRoute({
  method: "GET",
  path: "/api/overview",
  role: "owner",
  handler: async ({ deps, session }) => {
    const nowMs = deps.now().getTime();
    const data = await withWebTx(deps.pool, session.businessId, async (c) => {
      const business = await getBusinessForWeb(c, session.businessId);
      const policy = await getPolicyForWeb(c, session.businessId);
      if (business === null || policy === null) throw new HttpError(404, "NOT_FOUND", "Not found.");
      let date: string;
      try {
        date = businessDate(nowMs, business.timezone);
      } catch {
        throw new HttpError(500, "INTERNAL", "Something went wrong.");
      }
      return {
        business,
        policy,
        date,
        overview: await getOverviewData(c, session.businessId, date),
        queue: await listInvoiceQueueForWeb(c, session.businessId, 5),
        recent: (await listPaymentsForWeb(c, session.businessId, { limit: 5 })).rows,
        runs: await listAgentRunsForBusiness(c, session.businessId, { limit: 1 }),
        request: await getLatestAgentRunRequest(c, session.businessId),
        decision: await getLatestDecisionCode(c, session.businessId),
      };
    });
    const { business, policy, overview, date, queue, recent, runs, request, decision } = data;
    const remaining = Dec.max(new Dec(policy.daily_spend_limit).minus(new Dec(overview.held_today)), 0);
    const expired = policy.valid_until !== null && Date.parse(policy.valid_until) <= nowMs;
    let state: AutomationState = "active";
    if (!policy.enabled) state = "paused";
    else if (expired) state = "expired";
    else if (overview.invoice_counts.blocked > 0) state = "needs_attention";
    const asOfMs = overview.balance_as_of === null ? null : Date.parse(overview.balance_as_of);
    const ageSeconds = asOfMs === null || Number.isNaN(asOfMs) ? null : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
    const lastRun = runs[0] ?? null;
    let agentState: AgentState = "ready";
    if (lastRun?.status === "running") agentState = "running";
    else if (!policy.enabled) agentState = "paused";
    else if (lastRun !== null && RUN_PROBLEMS.has(lastRun.status)) agentState = "needs_attention";
    // The newest stored decision wins, whether it came from a payment or from the last run.
    const runDecisionAt = typeof lastRun?.decision_code === "string" && CODE.test(lastRun.decision_code) ? Date.parse(lastRun.started_at) : -1;
    const payDecisionAt = decision === null ? -1 : Date.parse(decision.at);
    const lastDecision = runDecisionAt >= payDecisionAt ? (runDecisionAt < 0 ? null : lastRun?.decision_code ?? null) : (decision?.code ?? null);
    return jsonResponse(200, {
      network: "XRPL Testnet",
      business: { name: business.name, timezone: business.timezone },
      treasury: {
        rlusd_balance: overview.rlusd_balance,
        as_of: overview.balance_as_of,
        source: overview.rlusd_balance === null ? "unavailable" : "snapshot",
        age_seconds: ageSeconds,
        stale: ageSeconds === null ? false : ageSeconds > BALANCE_STALE_SECONDS,
      },
      today: { business_date: date, automated_spend: overview.held_today, daily_limit: policy.daily_spend_limit, remaining_allowance: formatMoney(remaining) },
      limits: { minimum_reserve: policy.minimum_reserve, max_payment_amount: policy.max_payment_amount },
      automation: { state, enabled: policy.enabled, valid_until: policy.valid_until },
      invoices: overview.invoice_counts,
      agent: {
        state: agentState,
        last_run:
          lastRun === null
            ? null
            : { id: lastRun.id, started_at: lastRun.started_at, status: lastRun.status, trigger: lastRun.trigger, decision_code: lastRun.decision_code !== null && CODE.test(lastRun.decision_code) ? lastRun.decision_code : null, invoice_number: lastRun.candidate_invoice_number },
        run_request: request === null ? null : { status: request.status, requested_at: request.requested_at },
      },
      last_decision_code: lastDecision !== null && CODE.test(lastDecision) ? lastDecision : null,
      queue: queue.map((r) => invoiceView(r, false)),
      recent_payments: recent.map((r) => paymentView(r, false)),
    });
  },
});

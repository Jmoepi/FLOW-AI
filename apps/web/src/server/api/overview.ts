import { getBusinessForWeb, getOverviewData, getPolicyForWeb, withWebTx } from "@flow-ai/database";
import { Dec, businessDate, formatMoney } from "@flow-ai/policy-engine";
import { HttpError, jsonResponse } from "../http/errors";
import { defineRoute } from "../http/route";
export type AutomationState = "paused" | "expired" | "needs_attention" | "active";
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
      return { business, policy, date, overview: await getOverviewData(c, session.businessId, date) };
    });
    const { business, policy, overview, date } = data;
    const remaining = Dec.max(new Dec(policy.daily_spend_limit).minus(new Dec(overview.held_today)), 0);
    const expired = policy.valid_until !== null && Date.parse(policy.valid_until) <= nowMs;
    let state: AutomationState = "active";
    if (!policy.enabled) state = "paused";
    else if (expired) state = "expired";
    else if (overview.invoice_counts.blocked > 0) state = "needs_attention";
    return jsonResponse(200, {
      network: "XRPL Testnet",
      business: { name: business.name, timezone: business.timezone },
      treasury: {
        rlusd_balance: overview.rlusd_balance,
        as_of: overview.balance_as_of,
        source: overview.rlusd_balance === null ? "unavailable" : "snapshot",
      },
      today: { business_date: date, automated_spend: overview.held_today, daily_limit: policy.daily_spend_limit, remaining_allowance: formatMoney(remaining) },
      limits: { minimum_reserve: policy.minimum_reserve, max_payment_amount: policy.max_payment_amount },
      automation: { state, enabled: policy.enabled, valid_until: policy.valid_until },
      invoices: overview.invoice_counts,
    });
  },
});

import type { ReactNode } from "react";
import { StatusBadge, type Tone } from "./Badge";
import { formatInstant, rlusd } from "./format";
import type { OverviewData } from "./types";
const STATE: Record<OverviewData["automation"]["state"], { tone: Tone; label: string; text: string }> = {
  active: { tone: "ok", label: "Automation on", text: "The AI agent may request payments that pass every rule below." },
  paused: { tone: "neutral", label: "Automation paused", text: "No payment is approved while automation is paused. Turn it back on from Payment policies." },
  expired: { tone: "warn", label: "Policy expired", text: "The policy validity date has passed, so every payment request is blocked. Set a new date in Payment policies." },
  needs_attention: { tone: "warn", label: "Needs attention", text: "Automation is on, but some invoices are blocked by a rule and need your review." },
};
/** The four CFO questions as a description list, then the state line. All values are text. */
export function OverviewView({ data }: { data: OverviewData }): ReactNode {
  const state = STATE[data.automation.state];
  const tz = data.business.timezone;
  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        {data.business.name} on {data.network}. Amounts are test RLUSD with no real value.
      </p>
      <p>
        <StatusBadge tone={state.tone} label={state.label} /> <span>{state.text}</span>
      </p>
      <dl className="facts">
        <div>
          <dt>Treasury balance</dt>
          <dd>
            {data.treasury.rlusd_balance === null ? "Not available yet" : rlusd(data.treasury.rlusd_balance)}
            <small>
              {data.treasury.rlusd_balance === null
                ? "No balance snapshot has been recorded."
                : `Last balance snapshot, ${formatInstant(data.treasury.as_of, tz)}`}
            </small>
          </dd>
        </div>
        <div>
          <dt>Spent today by automation</dt>
          <dd>
            {rlusd(data.today.automated_spend)}
            <small>Business day {data.today.business_date}</small>
          </dd>
        </div>
        <div>
          <dt>Remaining allowance today</dt>
          <dd>
            {rlusd(data.today.remaining_allowance)}
            <small>Daily limit {rlusd(data.today.daily_limit)}</small>
          </dd>
        </div>
        <div>
          <dt>Minimum reserve</dt>
          <dd>
            {rlusd(data.limits.minimum_reserve)}
            <small>Always kept in the treasury. Largest single payment {rlusd(data.limits.max_payment_amount)}.</small>
          </dd>
        </div>
      </dl>
      <h2>Invoices</h2>
      <p>
        Needing attention (blocked by a rule): <strong>{data.invoices.blocked}</strong>. In progress: {data.invoices.processing}. Open: {data.invoices.open}.
      </p>
      <p>
        <a href="/policy">Review payment policies</a>
      </p>
    </>
  );
}

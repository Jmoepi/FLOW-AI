import type { ReactNode } from "react";
import { StatusBadge, type Tone } from "./Badge";
import { ControlPanel, RunAgentButton } from "./ControlPanel";
import { Freshness } from "./Freshness";
import { EmptyState } from "./States";
import { InvoiceTable, PaymentTable } from "./Tables";
import { explainDecision } from "./decision-codes";
import { formatInstant, rlusd } from "./format";
import { outcomeOf, triggerLabel } from "./agent-format";
import type { IconKey } from "./status-vocab";
import type { OverviewData, PolicyData } from "./types";
const STATE: Record<OverviewData["automation"]["state"], { tone: Tone; icon: IconKey; label: string; text: string }> = {
  active: { tone: "ok", icon: "check", label: "Automation on", text: "The AI agent may request payments that pass every rule below." },
  paused: { tone: "neutral", icon: "pause", label: "Automation paused", text: "No payment is approved while automation is paused. Turn it back on from Payment policies." },
  expired: { tone: "warn", icon: "clock", label: "Policy expired", text: "The policy validity date has passed, so every payment request is blocked. Set a new date in Payment policies." },
  needs_attention: { tone: "warn", icon: "warn", label: "Needs attention", text: "Automation is on, but some invoices are blocked by a rule and need your review." },
};
const AGENT: Record<OverviewData["agent"]["state"], { tone: Tone; icon: IconKey; label: string }> = {
  ready: { tone: "ok", icon: "check", label: "Ready" },
  running: { tone: "neutral", icon: "clock", label: "Running" },
  paused: { tone: "neutral", icon: "pause", label: "Paused" },
  needs_attention: { tone: "warn", icon: "warn", label: "Needs attention" },
};
/**
 * The four CFO questions, in order: what may the agent do (limits and state), who can it pay (suppliers), how do I stop it
 * (control panel), how do I prove it (payments and audit). Every value is text.
 */
export function OverviewView({ data, policy }: { data: OverviewData; policy: PolicyData }): ReactNode {
  const state = STATE[data.automation.state];
  const agent = AGENT[data.agent.state];
  const tz = data.business.timezone;
  const run = data.agent.last_run;
  const decision = data.last_decision_code === null ? null : explainDecision(data.last_decision_code);
  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        {data.business.name} on {data.network}. Amounts are test RLUSD with no real value.
      </p>
      <p>
        <StatusBadge tone={state.tone} icon={state.icon} label={state.label} /> <span>{state.text}</span>
      </p>
      <h2>What the agent may do</h2>
      <dl className="facts">
        <div>
          <dt>Treasury balance</dt>
          <dd>
            {data.treasury.rlusd_balance === null ? "Not available yet" : rlusd(data.treasury.rlusd_balance)}
            <small>
              <Freshness asOf={data.treasury.as_of} ageSeconds={data.treasury.age_seconds} stale={data.treasury.stale} timezone={tz} />
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
      <p>
        The agent can only pay <a href="/suppliers">suppliers you approved</a>.
      </p>
      <section className="panel" aria-labelledby="agent-title">
        <h2 id="agent-title">Treasury agent</h2>
        <p>
          <StatusBadge tone={agent.tone} icon={agent.icon} label={agent.label} />{" "}
          {run === null ? (
            "The agent has not run yet."
          ) : (
            <>
              Last run {formatInstant(run.started_at, tz)}, {triggerLabel(run.trigger).toLowerCase()}. Result: {outcomeOf(run.status).label}.
            </>
          )}
        </p>
        {decision === null ? null : (
          <p>
            Latest payment decision: {decision.title}. {decision.plain}
          </p>
        )}
        <RunAgentButton initial={data.agent.run_request} />
        <p>
          <a href="/agent">See Agent activity</a>
        </p>
      </section>
      <ControlPanel policy={policy} lastDecisionCode={data.last_decision_code} />
      <h2>Invoice queue</h2>
      <p>
        Needing attention (blocked by a rule): <strong>{data.invoices.blocked}</strong>. In progress: {data.invoices.processing}. Open: {data.invoices.open}.
      </p>
      {data.queue.length === 0 ? (
        <EmptyState title="No open invoices">Invoices that are open, in progress or blocked appear here, soonest due first.</EmptyState>
      ) : (
        <InvoiceTable invoices={data.queue} today={data.today.business_date} caption="Next invoices by due date" />
      )}
      <p>
        <a href="/invoices">All invoices</a>
      </p>
      <h2>Recent payments</h2>
      {data.recent_payments.length === 0 ? (
        <EmptyState title="No payments yet">When the agent requests a payment it appears here, with its transaction hash once sent.</EmptyState>
      ) : (
        <PaymentTable payments={data.recent_payments} timezone={tz} caption="Most recent payments" />
      )}
      <p>
        <a href="/payments">All payments</a> · <a href="/audit">Audit trail</a> · <a href="/policy">Payment policies</a>
      </p>
      <p className="hint">The payment service decides on every request. This page shows stored results and never guesses whether an invoice will be paid.</p>
    </>
  );
}

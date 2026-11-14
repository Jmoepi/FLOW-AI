import type { ReactNode } from "react";
import { describeEvent, displayStatus, modeLabel, outcomeOf, outcomeText, shortHash, triggerLabel } from "./agent-format";
import { StatusBadge } from "./Badge";
import { formatInstant } from "./format";
import { EmptyState } from "./States";
import type { AgentRunsPage } from "./types";
/** Read-only feed of agent runs. Every value is a React text child; the only link is the allowlisted testnet explorer URL. */
export function AgentActivityView({ page, timezone }: { page: AgentRunsPage; timezone: string }): ReactNode {
  const older = page.next_before_seq !== null && Number.isSafeInteger(page.next_before_seq) && page.next_before_seq > 0 ? page.next_before_seq : null;
  return (
    <>
      <h1 className="page-title">Agent activity</h1>
      <p className="lede">What the payment agent did and why. The payment service makes every decision. Newest first.</p>
      {page.runs.length === 0 ? (
        <EmptyState title="No agent runs yet." />
      ) : (
        <ol className="run-list">
          {page.runs.map((run) => {
            const outcome = outcomeOf(displayStatus(run));
            const link = run.payment?.explorer_url ?? null;
            const hash = run.payment?.tx_hash ?? null;
            const heading = `run-${String(run.seq)}`;
            return (
              <li key={run.id} aria-labelledby={heading}>
                <h2 id={heading} className="run-title">
                  <time dateTime={run.started_at}>{formatInstant(run.started_at, timezone)}</time>
                </h2>
                <p>
                  <StatusBadge tone={outcome.tone} label={outcome.label} />
                </p>
                <p className="hint">
                  {triggerLabel(run.trigger)}. Mode: {modeLabel(run)}.
                  {run.invoice_number !== null ? ` Invoice ${run.invoice_number}.` : ""}
                </p>
                <p>{outcomeText(run)}</p>
                {run.agent_reason !== null && run.agent_reason !== "" ? (
                  <figure className="run-reason">
                    <figcaption>Agent reason</figcaption>
                    <blockquote>{run.agent_reason}</blockquote>
                  </figure>
                ) : null}
                {link !== null && hash !== null ? (
                  <p>
                    <a href={link} target="_blank" rel="noopener noreferrer">
                      View transaction {shortHash(hash)} on the XRPL testnet explorer (opens in a new tab)
                    </a>
                  </p>
                ) : null}
                {run.events.length > 0 ? (
                  <details className="run-steps">
                    <summary>Steps ({run.events.length})</summary>
                    <ol>
                      {run.events.map((e) => (
                        <li key={e.seq}>{describeEvent(e)}</li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {older !== null ? (
        <p>
          <a className="btn btn-secondary" href={`/agent?before_seq=${String(older)}`}>
            Load older runs
          </a>
        </p>
      ) : null}
    </>
  );
}

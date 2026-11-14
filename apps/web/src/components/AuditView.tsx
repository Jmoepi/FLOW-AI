import type { ReactNode } from "react";
import { describeMetadata } from "./audit-format";
import { formatInstant } from "./format";
import { EmptyState } from "./States";
import type { AuditPage } from "./types";
const ACTOR: Record<string, string> = { you: "You", another_user: "Another user", agent: "AI agent", system: "System", guard: "Payment service" };
/** Read-only feed. Every value is text; the only link is built from an integer. */
export function AuditView({ page, timezone }: { page: AuditPage; timezone: string }): ReactNode {
  const older = page.next_before_seq !== null && Number.isSafeInteger(page.next_before_seq) && page.next_before_seq > 0 ? page.next_before_seq : null;
  return (
    <>
      <h1 className="page-title">Audit</h1>
      <p className="lede">A permanent, read-only record of rule changes and payment decisions. Newest first.</p>
      {page.events.length === 0 ? (
        <EmptyState title="No events yet." />
      ) : (
        <ol className="event-list">
          {page.events.map((e) => {
            const rows = describeMetadata(e.event_type, e.metadata);
            return (
              <li key={e.seq}>
                <p>
                  <strong className="event-type text-accent-3">{e.event_type}</strong> by {ACTOR[e.actor] ?? e.actor}
                </p>
                <p className="hint">{formatInstant(e.created_at, timezone)}</p>
                {rows.length > 0 ? (
                  <ul className="change-list">
                    {rows.map((r) => (
                      <li key={r.field}>
                        {r.field}: {r.before} to {r.after}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {older !== null ? (
        <p className="pager">
          <a href={`/audit?before_seq=${String(older)}`}>Older events</a>
        </p>
      ) : null}
    </>
  );
}

import type { ReactNode } from "react";
import { explainDecision } from "./decision-codes";
import { Icon } from "./ui/Icon";
/** Shared page states (spec 11.10): loading, empty, error and blocked. All text is fixed or caller-supplied plain text. */
export function LoadingSkeleton({ label }: { label: string }): ReactNode {
  return (
    <div role="status" aria-live="polite" className="skeleton-block">
      <span className="sr-only">{label}</span>
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton skeleton-short" aria-hidden="true" />
    </div>
  );
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="empty-state">
      <p className="state-title">
        <Icon name="file-text" className="size-5" />
        <strong>{title}</strong>
      </p>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}
/** No stack trace, no internal text. `retry` is a plain link so it works without script. */
export function ErrorState({ title, children, retryHref }: { title: string; children?: ReactNode; retryHref?: string }): ReactNode {
  return (
    <div className="error-summary" role="alert">
      <h2 className="state-title">
        <Icon name="alert" className="size-5" />
        {title}
      </h2>
      {children === undefined ? null : <p>{children}</p>}
      {retryHref === undefined ? null : (
        <p>
          <a href={retryHref}>Try again</a>
        </p>
      )}
    </div>
  );
}
/** A payment the service refused: the decision in plain language, what to do and a link to the rules. */
export function BlockedNotice({ code }: { code: string | null }): ReactNode {
  const e = explainDecision(code);
  return (
    <section className="guard-note" aria-labelledby="blocked-title">
      <h2 id="blocked-title" className="state-title">
        <Icon name="shield-x" className="size-5" />
        {e.title}
      </h2>
      <p>{e.plain}</p>
      <p>{e.whatToDo}</p>
      <p>
        <a href="/policy">Payment policies</a>
      </p>
    </section>
  );
}

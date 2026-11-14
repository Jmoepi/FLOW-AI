"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../components/ui/Icon";
/** Route error boundary. Shows no stack and no internal text; focus moves to the heading so the change is announced. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main id="main" tabIndex={-1} className="narrow">
      <div className="glass-card state-card" role="group" aria-labelledby="error-title">
        <h1 id="error-title" ref={heading} tabIndex={-1} className="page-title state-title">
          <Icon name="alert" className="size-6" />
          Something went wrong
        </h1>
        <p>This page could not be shown. Nothing was changed and no payment was made.</p>
        <p className="actions">
          <button type="button" className="btn" onClick={() => reset()}>
            Try again
          </button>
          <a className="btn btn-secondary" href="/">
            Go to Overview
          </a>
        </p>
      </div>
    </main>
  );
}

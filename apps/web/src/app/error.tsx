"use client";
import { useEffect, useRef, type ReactNode } from "react";
/** Route error boundary. Shows no stack and no internal text; focus moves to the heading so the change is announced. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }): ReactNode {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main id="main" tabIndex={-1}>
      <h1 ref={heading} tabIndex={-1}>
        Something went wrong
      </h1>
      <p>This page could not be shown. Nothing was changed and no payment was made.</p>
      <p className="actions">
        <button type="button" className="btn" onClick={() => reset()}>
          Try again
        </button>
        <a href="/">Go to Overview</a>
      </p>
    </main>
  );
}

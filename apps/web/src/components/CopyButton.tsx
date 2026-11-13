"use client";
import { useState, type ReactNode } from "react";
/** Copies an address or hash. The result is announced in a polite live region; the target is at least 24 px. */
export function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  const [message, setMessage] = useState("");
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch {
      setMessage(`Could not copy the ${label.toLowerCase()}. Select the text and copy it instead.`);
    }
  }
  return (
    <>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => void copy()}>
        Copy<span className="sr-only"> {label.toLowerCase()}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {message}
      </span>
    </>
  );
}

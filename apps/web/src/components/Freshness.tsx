import type { ReactNode } from "react";
import { StatusBadge } from "./Badge";
import { formatInstant } from "./format";
/** Balance freshness: the as_of instant, a relative age, and a non-colour "stale" or "unavailable" cue. */
export function ageText(seconds: number): string {
  if (seconds < 60) return "less than a minute ago";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m)} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${String(d)} days ago`;
}
export function Freshness({ asOf, ageSeconds, stale, timezone }: { asOf: string | null; ageSeconds: number | null; stale: boolean; timezone: string }): ReactNode {
  if (asOf === null || ageSeconds === null) {
    return (
      <span>
        <StatusBadge tone="warn" icon="warn" label="Balance unavailable" /> No balance snapshot has been recorded yet.
      </span>
    );
  }
  return (
    <span>
      As of {formatInstant(asOf, timezone)}, {ageText(ageSeconds)}.{" "}
      {stale ? <StatusBadge tone="warn" icon="clock" label="Stale" /> : <StatusBadge tone="ok" icon="check" label="Fresh" />}
    </span>
  );
}

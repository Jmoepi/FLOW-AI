import type { ReactNode } from "react";
import type { IconKey } from "./status-vocab";
/** Status is never colour alone: every badge carries a text label and a distinct inline icon shape. */
export type Tone = "ok" | "warn" | "bad" | "neutral";
const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const ICONS: Record<IconKey, ReactNode> = {
  check: <path d="M3 8.5l3.2 3.2L13 5" {...S} />,
  warn: <path d="M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.6v.4" {...S} strokeWidth={1.6} />,
  cross: <path d="M4 4l8 8M12 4l-8 8" {...S} />,
  pause: <path d="M5 3v10M11 3v10" {...S} />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" {...S} />
      <path d="M8 5v3.2l2 1.3" {...S} />
    </>
  ),
  arrow: <path d="M2 8h11M9 4l4 4-4 4" {...S} />,
  ban: (
    <>
      <circle cx="8" cy="8" r="5.5" {...S} />
      <path d="M4 12L12 4" {...S} />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" {...S} />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" {...S} />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" />,
  doc: <path d="M4 2.5h5.5L12 5v8.5H4zM6 8h4M6 10.5h4" {...S} strokeWidth={1.5} />,
};
const TONE_ICON: Record<Tone, IconKey> = { ok: "check", warn: "warn", bad: "cross", neutral: "pause" };
function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
export function StatusBadge({ tone, label, icon }: { tone: Tone; label: string; icon?: IconKey }): ReactNode {
  return (
    <span className={`badge badge-${tone}`}>
      <Icon>{ICONS[icon ?? TONE_ICON[tone]]}</Icon>
      {label}
    </span>
  );
}
/** Always visible: the owner must never mistake this environment for real funds (spec 13.3). */
export function NetworkBadge({ network }: { network: string }): ReactNode {
  return (
    <span className="badge badge-network">
      <Icon>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="8" cy="8" r="1.8" fill="currentColor" />
      </Icon>
      {network}
    </span>
  );
}

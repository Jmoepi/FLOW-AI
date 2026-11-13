import type { ReactNode } from "react";
/** Status is never colour alone: every badge carries a text label and a distinct inline icon shape. */
export type Tone = "ok" | "warn" | "bad" | "neutral";
const ICONS: Record<Tone, ReactNode> = {
  ok: <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  warn: <path d="M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.6v.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  bad: <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  neutral: <path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
};
function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
export function StatusBadge({ tone, label }: { tone: Tone; label: string }): ReactNode {
  return (
    <span className={`badge badge-${tone}`}>
      <Icon>{ICONS[tone]}</Icon>
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

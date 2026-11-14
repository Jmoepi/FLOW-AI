import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
/** Colour is never the only cue: every state has an icon and a text label. Red is danger only together with icon + text. */
export type ChipState = "success" | "pending" | "blocked" | "degraded" | "revoked";
const STATE: Record<ChipState, { icon: IconName; label: string; cls: string }> = {
  success: { icon: "check", label: "Paid", cls: "border-emerald-500/40 bg-emerald-950 text-emerald-300" },
  pending: { icon: "clock", label: "Pending", cls: "border-amber-500/40 bg-amber-950 text-amber-300" },
  blocked: { icon: "shield-x", label: "Blocked", cls: "border-red-500/40 bg-red-950 text-red-300" },
  degraded: { icon: "alert", label: "Degraded", cls: "border-red-500/40 bg-red-950 text-red-300" },
  revoked: { icon: "alert", label: "Revoked", cls: "border-red-500/40 bg-red-950 text-red-300" },
};
export function StatusChip({ state, label }: { state: ChipState; label?: string }): ReactNode {
  const s = STATE[state];
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${s.cls}`}>
      <Icon name={s.icon} className="size-3.5" />
      <span className="min-w-0 break-words">{label ?? s.label}</span>
    </span>
  );
}

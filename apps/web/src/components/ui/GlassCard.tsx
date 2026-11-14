import type { ElementType, ReactNode } from "react";
/** Glass surface (.glass-card). Hover lift has a focus-within equivalent and is disabled under reduced motion in globals.css. */
export function GlassCard({ as: Tag = "div", className = "", children }: { as?: ElementType; className?: string; children: ReactNode }): ReactNode {
  return <Tag className={`glass-card p-6 ${className}`.trim()}>{children}</Tag>;
}

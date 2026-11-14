import type { ReactNode } from "react";
/** Decorative blurred accent orbs. */
export function GlowOrbs(): ReactNode {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-40 left-1/4 size-96 rounded-full bg-accent/10 blur-3xl mix-blend-screen" />
      <div className="absolute right-0 bottom-0 size-80 rounded-full bg-accent/5 blur-3xl mix-blend-screen" />
    </div>
  );
}

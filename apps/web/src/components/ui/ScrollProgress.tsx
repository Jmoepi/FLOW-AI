import type { ReactNode } from "react";
/** 2px accent bar driven by CSS scroll-timeline (.scroll-progress in globals.css). Hidden where unsupported or under reduced motion. */
export function ScrollProgress(): ReactNode {
  return <div aria-hidden="true" className="scroll-progress pointer-events-none fixed top-0 left-0 z-50 h-0.5 w-full bg-accent shadow-accent-glow" />;
}

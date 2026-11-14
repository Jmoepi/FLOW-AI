import Link from "next/link";
import type { ReactNode } from "react";
/** Black pill with the animated border sweep (.shiny-cta). The sweep stops under prefers-reduced-motion (globals.css). */
const CLASS =
  "shiny-cta inline-flex min-h-11 items-center justify-center gap-2 px-6 py-2 text-sm font-medium text-white md:min-h-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:animate-none";
export function ShinyButton({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <Link href={href} className={`${CLASS} ${className}`.trim()}>
      {children}
    </Link>
  );
}

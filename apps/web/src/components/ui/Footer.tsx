import Link from "next/link";
import type { ReactNode } from "react";
/** Site footer. Only real routes; the watermark is decorative. No claims beyond what the README states. */
export function Footer(): ReactNode {
  return (
    <footer className="relative mt-16 overflow-hidden border-t border-white/10">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6">
        <div>
          <p className="font-display text-lg font-bold text-white">Flow AI</p>
          <p className="mt-2 max-w-xs text-sm text-zinc-400">Testnet only, hackathon MVP. Not production software and not financial advice.</p>
        </div>
        <nav aria-label="Footer: product">
          <p className="text-xs font-medium tracking-widest text-zinc-400 uppercase">Product</p>
          <ul className="mt-3 space-y-1 text-sm">
            <li>
              <Link href="/login" className="inline-flex min-h-8 items-center text-zinc-300 hover:text-white">
                Sign in
              </Link>
            </li>
            <li>
              <a href="#capabilities" className="inline-flex min-h-8 items-center text-zinc-300 hover:text-white">
                Capabilities
              </a>
            </li>
            <li>
              <a href="#how-it-works" className="inline-flex min-h-8 items-center text-zinc-300 hover:text-white">
                How it works
              </a>
            </li>
          </ul>
        </nav>
        <div>
          <p className="text-xs font-medium tracking-widest text-zinc-400 uppercase">Network</p>
          <p className="mt-3 text-sm text-zinc-300">XRPL Testnet, no real funds.</p>
          <p className="mt-1 text-sm text-zinc-300">Security notes: SECURITY.md and docs/security-review.md in the repository.</p>
        </div>
      </div>
      <p aria-hidden="true" className="watermark pointer-events-none -mb-6 text-center font-display text-[22vw] leading-none font-extrabold tracking-tighter select-none">
        FLOW
      </p>
    </footer>
  );
}

import type { ReactNode } from "react";
import { NetworkBadge } from "./Badge";
import { LogoutButton } from "./LogoutButton";
import { MobileMenu } from "./ui/MobileMenu";
export type NavKey = "overview" | "invoices" | "payments" | "suppliers" | "policy" | "agent" | "audit";
export const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "overview", href: "/", label: "Overview" },
  { key: "invoices", href: "/invoices", label: "Invoices" },
  { key: "payments", href: "/payments", label: "Payments" },
  { key: "suppliers", href: "/suppliers", label: "Suppliers" },
  { key: "policy", href: "/policy", label: "Payment policies" },
  { key: "agent", href: "/agent", label: "Agent activity" },
  { key: "audit", href: "/audit", label: "Audit" },
];
/** One banner for the whole app, rendered by the root layout so error, not-found and login pages carry it too. */
export function TestnetBanner(): ReactNode {
  return (
    <div className="testnet-banner">
      <NetworkBadge network="TESTNET DEMO" /> <span>XRPL Testnet, no real funds</span>
    </div>
  );
}
export function SkipLink(): ReactNode {
  return (
    <a className="skip-link" href="#main">
      Skip to main content
    </a>
  );
}
export const PILL = "relative mx-auto flex w-full max-w-6xl items-center justify-between gap-3 rounded-full border border-white/10 bg-black/60 px-3 py-2 backdrop-blur-xl";
export const LINK = "inline-flex min-h-11 items-center rounded-full px-3 text-sm text-zinc-400 hover:text-white focus-visible:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-[current=page]:bg-white/10 aria-[current=page]:font-semibold aria-[current=page]:text-white whitespace-nowrap lg:min-h-10 lg:px-2.5";
/** Small gradient tile (accent to black) plus the brand name in the display font. */
export function Brand({ name }: { name: string }): ReactNode {
  return (
    <p className="m-0 flex min-w-0 items-center gap-2 font-display font-bold text-white">
      <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-accent to-black text-sm">
        F
      </span>
      <span className="max-w-[14rem] truncate lg:max-w-[16rem] xl:max-w-xs" title={name}>{name}</span>
    </p>
  );
}
/** Authenticated frame: skip link first, then the floating pill header (business, main navigation, sign out) and the main landmark. */
export function Shell({ businessName, current, children }: { businessName: string; current: NavKey; children: ReactNode }): ReactNode {
  return (
    <>
      <SkipLink />
      <header className="sticky top-2 z-40 px-3 pt-3">
        <div className={PILL}>
          <Brand name={businessName} />
          <MobileMenu label="Menu">
            <nav aria-label="Main">
              <ul className="m-0 flex list-none flex-col gap-1 p-0 lg:flex-row lg:flex-nowrap lg:justify-end">
                {NAV.map((n) => (
                  <li key={n.key}>
                    <a className={LINK} href={n.href} aria-current={n.key === current ? "page" : undefined}>
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-wrap items-center gap-2">
              <LogoutButton />
            </div>
          </MobileMenu>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
/** Unauthenticated frame (login). */
export function PublicShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <>
      <SkipLink />
      <header className="px-3 pt-3">
        <div className={PILL.replace("justify-between", "justify-center")}>
          <Brand name="Flow AI" />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="narrow">
        {children}
      </main>
    </>
  );
}

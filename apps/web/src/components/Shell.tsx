import type { ReactNode } from "react";
import { NetworkBadge } from "./Badge";
import { LogoutButton } from "./LogoutButton";
export type NavKey = "overview" | "suppliers" | "policy" | "agent" | "audit";
const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "overview", href: "/", label: "Overview" },
  { key: "suppliers", href: "/suppliers", label: "Suppliers" },
  { key: "policy", href: "/policy", label: "Payment policies" },
  { key: "agent", href: "/agent", label: "Agent activity" },
  { key: "audit", href: "/audit", label: "Audit" },
];
function SkipLink(): ReactNode {
  return (
    <a className="skip-link" href="#main">
      Skip to main content
    </a>
  );
}
/** Authenticated frame: skip link first, then header (business, network badge), main navigation and the main landmark. */
export function Shell({ businessName, current, children }: { businessName: string; current: NavKey; children: ReactNode }): ReactNode {
  return (
    <>
      <SkipLink />
      <header className="site-header">
        <p className="brand">{businessName}</p>
        <NetworkBadge network="XRPL Testnet" />
        <nav className="site-nav" aria-label="Main">
          <ul>
            {NAV.map((n) => (
              <li key={n.key}>
                <a href={n.href} aria-current={n.key === current ? "page" : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="header-actions">
          <LogoutButton />
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
      <header className="site-header">
        <p className="brand">Flow AI</p>
        <NetworkBadge network="XRPL Testnet" />
      </header>
      <main id="main" tabIndex={-1} className="narrow">
        {children}
      </main>
    </>
  );
}

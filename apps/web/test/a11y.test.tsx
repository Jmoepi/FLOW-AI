// @vitest-environment jsdom
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActivityView } from "../src/components/AgentActivityView";
import { AuditView } from "../src/components/AuditView";
import { LoginForm } from "../src/components/LoginForm";
import { InvoiceDetailView } from "../src/components/InvoiceDetailView";
import { InvoicesView } from "../src/components/InvoicesView";
import { OverviewView } from "../src/components/OverviewView";
import { PaymentDetailView } from "../src/components/PaymentDetailView";
import { PaymentsView } from "../src/components/PaymentsView";
import ErrorPage from "../src/app/error";
import NotFound from "../src/app/not-found";
import { BlockedNotice, EmptyState, ErrorState, LoadingSkeleton } from "../src/components/States";
import { PolicyForm } from "../src/components/PolicyForm";
import { PublicShell, Shell, TestnetBanner, type NavKey } from "../src/components/Shell";
import { Landing } from "../src/components/Landing";
import { StatusChip, type ChipState } from "../src/components/ui/StatusChip";
import { SuppliersView } from "../src/components/SuppliersView";
import { AGENT_RUNS, AUDIT, INVOICE_BLOCKED, INVOICE_OPEN, OVERVIEW, PAIR, PAYMENT_BLOCKED, PAYMENT_PAID, PAYMENT_PENDING, POLICY, SUPPLIERS } from "./ui-fixtures";
/**
 * axe-core running in jsdom. Limits (documented in docs/m4-notes.md): jsdom has no layout engine, so colour contrast,
 * reflow, target size and focus visibility are NOT judged here (contrast.test.ts checks the tokens; the rest is manual).
 * This is an automated subset, not an accessibility audit.
 */
beforeEach(() => {
  document.documentElement.lang = "en";
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function violations(ui: ReactNode, title: string): Promise<string[]> {
  document.title = title;
  render(ui);
  const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
const shell = (current: NavKey, body: ReactNode): ReactNode => (
  <Shell businessName="Acme Test Co" current={current}>
    {body}
  </Shell>
);
describe("axe-core (jsdom) finds no violations", () => {
  it("login", async () => {
    expect(await violations(<PublicShell><LoginForm /></PublicShell>, "Sign in | Flow AI")).toEqual([]);
  });
  it("login re-authentication variant", async () => {
    expect(await violations(<PublicShell><LoginForm reauth /></PublicShell>, "Sign in | Flow AI")).toEqual([]);
  });
  it("overview", async () => {
    expect(await violations(shell("overview", <OverviewView data={OVERVIEW} policy={POLICY} />), "Overview | Flow AI")).toEqual([]);
  });
  const OVERVIEW_STATES: [string, typeof OVERVIEW, typeof POLICY][] = [
    ["paused", { ...OVERVIEW, automation: { state: "paused", enabled: false, valid_until: null }, agent: { ...OVERVIEW.agent, state: "paused" } }, { ...POLICY, enabled: false }],
    ["expired", { ...OVERVIEW, automation: { state: "expired", enabled: true, valid_until: "2025-01-01T00:00:00.000Z" }, last_decision_code: "MANDATE_EXPIRED" }, POLICY],
    ["needs attention", { ...OVERVIEW, automation: { state: "needs_attention", enabled: true, valid_until: null }, agent: { ...OVERVIEW.agent, state: "needs_attention" } }, POLICY],
    ["stale balance", { ...OVERVIEW, treasury: { ...OVERVIEW.treasury, age_seconds: 4000, stale: true } }, POLICY],
    ["unavailable balance", { ...OVERVIEW, treasury: { rlusd_balance: null, as_of: null, source: "unavailable", age_seconds: null, stale: false } }, POLICY],
    ["empty queue and no runs", { ...OVERVIEW, queue: [], recent_payments: [], last_decision_code: null, agent: { state: "ready", last_run: null, run_request: null } }, POLICY],
    ["emergency stop on the last decision", { ...OVERVIEW, last_decision_code: "EXECUTION_DISABLED" }, POLICY],
    ["signing key revoked", { ...OVERVIEW, signing_key: { state: "revoked" } }, POLICY],
    ["signing key not set", { ...OVERVIEW, signing_key: { state: "not_set" } }, POLICY],
    ["signing key on another regular key", { ...OVERVIEW, signing_key: { state: "other" } }, POLICY],
    ["signing key unknown", { ...OVERVIEW, signing_key: { state: "unknown" } }, POLICY],
    ["run requested", { ...OVERVIEW, agent: { ...OVERVIEW.agent, run_request: { status: "open", requested_at: "2026-01-15T10:00:00.000Z" } } }, POLICY],
  ];
  it.each(OVERVIEW_STATES)("overview in the %s state", async (_name, data, policy) => {
    expect(await violations(shell("overview", <OverviewView data={data} policy={policy} />), "Overview | Flow AI")).toEqual([]);
  });
  it("invoices list, filtered, empty and paged", async () => {
    const page = { invoices: [INVOICE_BLOCKED, INVOICE_OPEN], page: 2, has_more: true };
    expect(await violations(shell("invoices", <InvoicesView page={page} status="open" today="2026-01-15" />), "Invoices | Flow AI")).toEqual([]);
  });
  it("invoices list when empty", async () => {
    expect(await violations(shell("invoices", <InvoicesView page={{ invoices: [], page: 1, has_more: false }} status={null} today="2026-01-15" />), "Invoices | Flow AI")).toEqual([]);
  });
  it("invoice detail, open and blocked", async () => {
    expect(await violations(shell("invoices", <InvoiceDetailView invoice={INVOICE_OPEN} today="2026-01-15" />), "Invoice | Flow AI")).toEqual([]);
    cleanup();
    expect(await violations(shell("invoices", <InvoiceDetailView invoice={INVOICE_BLOCKED} today="2026-01-15" />), "Invoice | Flow AI")).toEqual([]);
  });
  it("payments list and empty", async () => {
    const page = { payments: [PAYMENT_PAID, PAYMENT_BLOCKED, PAYMENT_PENDING], page: 1, has_more: false };
    expect(await violations(shell("payments", <PaymentsView page={page} status={null} timezone="Europe/London" />), "Payments | Flow AI")).toEqual([]);
    cleanup();
    expect(await violations(shell("payments", <PaymentsView page={{ payments: [], page: 1, has_more: false }} status="failed" timezone="UTC" />), "Payments | Flow AI")).toEqual([]);
  });
  it("payment detail: validated, blocked and pending", async () => {
    for (const p of [PAYMENT_PAID, PAYMENT_BLOCKED, PAYMENT_PENDING]) {
      expect(await violations(shell("payments", <PaymentDetailView payment={p} timezone="Europe/London" />), "Payment | Flow AI")).toEqual([]);
      cleanup();
    }
  });
  it("loading, empty, error and blocked states", async () => {
    const body = (
      <>
        <h1>States</h1>
        <LoadingSkeleton label="Loading invoices" />
        <EmptyState title="Nothing here">Add something.</EmptyState>
        <ErrorState title="Could not load" retryHref="/invoices">
          Try again in a moment.
        </ErrorState>
        <BlockedNotice code="MINIMUM_RESERVE_BREACHED" />
      </>
    );
    expect(await violations(shell("invoices", body), "States | Flow AI")).toEqual([]);
  });
  it("error and not-found pages are valid, name the problem and offer a way out", async () => {
    expect(await violations(<ErrorPage error={new Error("internal detail")} reset={() => undefined} />, "Error | Flow AI")).toEqual([]);
    expect(document.body.textContent).not.toContain("internal detail");
    expect(document.activeElement?.tagName).toBe("H1");
    cleanup();
    expect(await violations(<NotFound />, "Not found | Flow AI")).toEqual([]);
  });
  it("the Testnet banner is rendered by the app layout and is plain text", () => {
    render(<TestnetBanner />);
    expect(document.body.textContent).toContain("TESTNET DEMO");
    expect(document.body.textContent).toContain("no real funds");
  });
  it("policy", async () => {
    expect(await violations(shell("policy", <PolicyForm initial={POLICY} timezone="Europe/London" pair={PAIR} />), "Payment policies | Flow AI")).toEqual([]);
  });
  it("policy with an expiry date and paused", async () => {
    const p = { ...POLICY, enabled: false, valid_until: "2027-01-01T00:00:00.000Z" };
    expect(await violations(shell("policy", <PolicyForm initial={p} timezone={null} pair={PAIR} />), "Payment policies | Flow AI")).toEqual([]);
  });
  it("suppliers", async () => {
    expect(await violations(shell("suppliers", <SuppliersView initial={SUPPLIERS} />), "Suppliers | Flow AI")).toEqual([]);
  });
  it("suppliers when empty", async () => {
    expect(await violations(shell("suppliers", <SuppliersView initial={[]} />), "Suppliers | Flow AI")).toEqual([]);
  });
  it("agent activity", async () => {
    expect(await violations(shell("agent", <AgentActivityView page={AGENT_RUNS} timezone="Europe/London" />), "Agent activity | Flow AI")).toEqual([]);
  });
  it("agent activity when empty", async () => {
    expect(await violations(shell("agent", <AgentActivityView page={{ runs: [], next_before_seq: null }} timezone="UTC" />), "Agent activity | Flow AI")).toEqual([]);
  });
  it("audit", async () => {
    expect(await violations(shell("audit", <AuditView page={AUDIT} timezone="Europe/London" />), "Audit | Flow AI")).toEqual([]);
  });
  it("each page has exactly one h1 and a labelled main navigation", () => {
    render(shell("policy", <PolicyForm initial={POLICY} timezone={null} pair={PAIR} />));
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Main");
    expect(document.querySelector("a.skip-link")).not.toBeNull();
  });
});

describe("axe-core (jsdom): landing, nav and status chips", () => {
  it("landing page", async () => {
    expect(await violations(<Landing />, "Flow AI | Limits you can prove")).toEqual([]);
  });
  it("authenticated shell with the nav menu open", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    document.title = "Invoices | Flow AI";
    render(shell("invoices", <h1>Invoices</h1>));
    await user.click(document.querySelector("button[aria-controls]") as HTMLElement);
    const r = await axe.run(document, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
  it("every status chip state has a text label and passes axe", async () => {
    const states: ChipState[] = ["success", "pending", "blocked", "degraded", "revoked"];
    expect(
      await violations(
        <main>
         <ul>
          {states.map((s) => (
            <li key={s}>
              <StatusChip state={s} />
            </li>
          ))}
         </ul>
        </main>,
        "Chips | Flow AI",
      ),
    ).toEqual([]);
  });
});

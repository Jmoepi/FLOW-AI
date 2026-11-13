// @vitest-environment jsdom
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditView } from "../src/components/AuditView";
import { LoginForm } from "../src/components/LoginForm";
import { OverviewView } from "../src/components/OverviewView";
import { PolicyForm } from "../src/components/PolicyForm";
import { PublicShell, Shell } from "../src/components/Shell";
import { SuppliersView } from "../src/components/SuppliersView";
import { AUDIT, OVERVIEW, PAIR, POLICY, SUPPLIERS } from "./ui-fixtures";
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
const shell = (current: "overview" | "suppliers" | "policy" | "audit", body: ReactNode): ReactNode => (
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
    expect(await violations(shell("overview", <OverviewView data={OVERVIEW} />), "Overview | Flow AI")).toEqual([]);
  });
  it("overview in the paused, expired and unavailable-balance states", async () => {
    const odd = { ...OVERVIEW, treasury: { rlusd_balance: null, as_of: null, source: "unavailable" as const }, automation: { state: "paused" as const, enabled: false, valid_until: null } };
    expect(await violations(shell("overview", <OverviewView data={odd} />), "Overview | Flow AI")).toEqual([]);
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
  it("audit", async () => {
    expect(await violations(shell("audit", <AuditView page={AUDIT} timezone="Europe/London" />), "Audit | Flow AI")).toEqual([]);
  });
  it("each page has exactly one h1 and a labelled main navigation", () => {
    render(shell("policy", <PolicyForm initial={POLICY} timezone={null} pair={PAIR} />));
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe("Main");
    expect(document.querySelector("a.skip-link")).not.toBeNull();
    expect(document.body.textContent).toContain("XRPL Testnet");
  });
});

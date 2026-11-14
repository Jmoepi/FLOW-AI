// @vitest-environment jsdom
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivityView } from "../src/components/AgentActivityView";
import { AuditView } from "../src/components/AuditView";
import { describeMetadata } from "../src/components/audit-format";
import { InvoiceDetailView } from "../src/components/InvoiceDetailView";
import { PaymentDetailView } from "../src/components/PaymentDetailView";
import { OverviewView } from "../src/components/OverviewView";
import { Shell } from "../src/components/Shell";
import { SuppliersView } from "../src/components/SuppliersView";
import { AGENT_RUNS, AUDIT, HASH, INVOICE_OPEN, OVERVIEW, PAYMENT_PAID, POLICY, SUPPLIERS } from "./ui-fixtures";
afterEach(cleanup);
const HOSTILE = ['<img src=x onerror="alert(1)">', '"><script>alert(1)</script>', "javascript:alert(1)", "<svg onload=alert(1)>", "</td><td><b>x</b>"];
// Elements that would exist only if hostile text had been parsed as markup.
const INJECTED = "img, script, svg[onload], b, [onerror], [onload], a[href^='javascript' i]";
describe("hostile text is rendered as text, never as markup", () => {
  it.each(HOSTILE)("supplier name and address: %s", (evil) => {
    const supplier = { ...SUPPLIERS[0]!, name: evil, xrpl_address: evil };
    const { container } = render(<SuppliersView initial={[supplier]} />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
    expect(container.textContent).toContain(evil.slice(0, 6));
    for (const el of container.querySelectorAll("a")) expect(el.getAttribute("href") ?? "").not.toMatch(/^javascript/i);
  });
  it.each(HOSTILE)("audit event type, actor and metadata: %s", (evil) => {
    const page = {
      events: [{ ...AUDIT.events[0]!, event_type: evil, actor: evil, metadata: { changed: [evil], before: { [evil]: evil }, after: { [evil]: evil }, field: evil } }],
      next_before_seq: null,
    };
    const { container } = render(<AuditView page={page} timezone="UTC" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
    expect(container.querySelectorAll("li").length).toBeGreaterThan(0);
  });
  it.each(HOSTILE)("whitelisted metadata values stay plain strings: %s", (evil) => {
    const rows = describeMetadata("policy.updated", { changed: ["valid_until", evil], before: { valid_until: evil }, after: { valid_until: evil } });
    expect(rows).toEqual([{ field: "Policy expiry", before: evil, after: evil }]);
    const { container } = render(<AuditView page={{ events: [{ ...AUDIT.events[0]!, metadata: { changed: ["valid_until"], before: { valid_until: evil }, after: { valid_until: evil } } }], next_before_seq: null }} timezone="UTC" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
  });
  it.each(HOSTILE)("business name in the shell and overview: %s", (evil) => {
    vi.stubGlobal("fetch", vi.fn());
    const data = { ...OVERVIEW, business: { name: evil, timezone: "UTC" } };
    const { container } = render(
      <Shell businessName={evil} current="overview">
        <OverviewView data={data} policy={POLICY} />
      </Shell>,
    );
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
  it("server-rendered HTML escapes the markup characters", () => {
    const html = renderToString(<AuditView page={{ events: [{ ...AUDIT.events[0]!, event_type: HOSTILE[1]! }], next_before_seq: null }} timezone="UTC" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('"><script');
  });
  it("unknown metadata keys and nested objects are not shown", () => {
    expect(describeMetadata("policy.updated", { changed: ["max_payment_amount"], before: { max_payment_amount: { nested: "<b>x</b>" } }, after: { max_payment_amount: "1" }, secret: "x" })).toEqual([
      { field: "Largest single payment", before: "(not shown)", after: "1" },
    ]);
    expect(describeMetadata("payment.blocked", { anything: "<b>x</b>" })).toEqual([]);
  });
  it("source has no dangerouslySetInnerHTML (also enforced by eslint)", () => {
    const dir = join(process.cwd(), "src", "components");
    for (const f of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (/\.tsx?$/.test(f)) expect(fs.readFileSync(join(dir, f), "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
describe("agent activity renders agent text as text only", () => {
  const REASON = "<img src=x onerror=alert(1)><script>x</script>[link](javascript:alert(1))";
  const withRun = (patch: Partial<(typeof AGENT_RUNS.runs)[number]>) => ({ runs: [{ ...AGENT_RUNS.runs[0]!, ...patch }], next_before_seq: null });
  it("agent_reason appears as text with no element created and no link besides the explorer", () => {
    const { container } = render(<AgentActivityView page={withRun({ agent_reason: REASON })} timezone="UTC" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
    expect(container.querySelector("blockquote")?.textContent).toBe(REASON);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([`https://testnet.xrpl.org/transactions/${HASH}`]);
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it.each(HOSTILE)("event fields and invoice number: %s", (evil) => {
    const page = withRun({ invoice_number: evil, decision_code: evil, events: [{ ...AGENT_RUNS.runs[0]!.events[0]!, tool_name: evil, error_code: evil, kind: evil, ok: false }] });
    const { container } = render(<AgentActivityView page={page} timezone="UTC" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
  });
  it("no explorer link is rendered without a server-built URL", () => {
    const run = AGENT_RUNS.runs[0]!;
    const { container } = render(<AgentActivityView page={withRun({ payment: { ...run.payment!, explorer_url: null } })} timezone="UTC" />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
  it("server-rendered HTML escapes the reason", () => {
    const html = renderToString(<AgentActivityView page={withRun({ agent_reason: REASON })} timezone="UTC" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
describe("invoices and payments render untrusted text as text only", () => {
  it.each(HOSTILE)("invoice description, number and supplier: %s", (evil) => {
    const invoice = { ...INVOICE_OPEN, description: evil, invoice_number: evil, supplier_name: evil, blocked_code: evil, status: "blocked" };
    const { container } = render(<InvoiceDetailView invoice={invoice} today="2026-01-15" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
    for (const el of container.querySelectorAll("a")) expect(el.getAttribute("href") ?? "").not.toMatch(/^javascript/i);
  });
  it.each(HOSTILE)("payment failure message, reason and code: %s", (evil) => {
    const payment = { ...PAYMENT_PAID, status: "failed", failure_message: evil, agent_reason: evil, failure_code: evil, invoice_number: evil, supplier_name: evil };
    const { container } = render(<PaymentDetailView payment={payment} timezone="UTC" />);
    expect(container.querySelectorAll(INJECTED)).toHaveLength(0);
  });
  it("the only external link is the server-built explorer URL", () => {
    const { container } = render(<PaymentDetailView payment={PAYMENT_PAID} timezone="UTC" />);
    const external = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("http"));
    expect(external).toEqual([`https://testnet.xrpl.org/transactions/${HASH}`]);
  });
  it("no explorer link without a server-built URL, and a pending hash is not described as paid", () => {
    const { container } = render(<PaymentDetailView payment={{ ...PAYMENT_PAID, status: "pending_confirmation", explorer_url: null }} timezone="UTC" />);
    expect([...container.querySelectorAll("a")].filter((a) => (a.getAttribute("href") ?? "").startsWith("http"))).toHaveLength(0);
    expect(container.textContent).toContain("Not yet confirmed on the ledger");
    expect(container.textContent).not.toMatch(/\bPaid\b/);
  });
});

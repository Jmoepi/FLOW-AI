// @vitest-environment jsdom
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditView } from "../src/components/AuditView";
import { describeMetadata } from "../src/components/audit-format";
import { OverviewView } from "../src/components/OverviewView";
import { Shell } from "../src/components/Shell";
import { SuppliersView } from "../src/components/SuppliersView";
import { AUDIT, OVERVIEW, SUPPLIERS } from "./ui-fixtures";
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
        <OverviewView data={data} />
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
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(join(dir, f), "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});

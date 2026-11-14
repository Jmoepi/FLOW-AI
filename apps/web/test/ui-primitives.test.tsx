// @vitest-environment jsdom
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Button } from "../src/components/ui/Button";
import { GlassCard } from "../src/components/ui/GlassCard";
import { Globe, GLOBE_DOT_COUNT } from "../src/components/ui/Globe";
import { GlowOrbs } from "../src/components/ui/GlowOrbs";
import { ICON_NAMES, Icon } from "../src/components/ui/Icon";
import { ScrollProgress } from "../src/components/ui/ScrollProgress";
import { Section } from "../src/components/ui/Section";
import { ShinyButton } from "../src/components/ui/ShinyButton";
import { Starfield, STAR_TOTAL } from "../src/components/ui/Starfield";
import { StatusChip, type ChipState } from "../src/components/ui/StatusChip";
beforeEach(() => {
  document.documentElement.lang = "en";
  document.title = "Primitives | Flow AI";
});
afterEach(cleanup);
const markup = (el: Element): string => new XMLSerializer().serializeToString(el).replace(/ xmlns="[^"]*"/g, "");
async function violations(ui: ReactNode): Promise<string[]> {
  render(<main>{ui}</main>);
  const r = await axe.run(document, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
describe("ui primitives", () => {
  it("render without axe violations", async () => {
    const ui = (
      <>
        <Section id="s" heading="Heading" level={1} eyebrow="Eyebrow">
          <GlassCard>
            <Icon name="shield" />
            <StatusChip state="success" />
          </GlassCard>
          <Button href="/login">Sign in</Button>
          <Button variant="secondary">Other</Button>
          <ShinyButton href="/login">Shiny</ShinyButton>
        </Section>
        <Starfield />
        <Globe />
        <GlowOrbs />
        <ScrollProgress />
      </>
    );
    expect(await violations(ui)).toEqual([]);
  });
  it("Section uses the requested heading level and labels itself", () => {
    const { container } = render(<Section id="x" heading="Title" level={3} />);
    expect(container.querySelector("h3#x-heading")?.textContent).toBe("Title");
    expect(container.querySelector("section")?.getAttribute("aria-labelledby")).toBe("x-heading");
  });
  it("Icon is decorative by default and labelled with a title", () => {
    for (const n of ICON_NAMES) {
      const { container } = render(<Icon name={n} />);
      expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      cleanup();
    }
    const { container } = render(<Icon name="check" title="Done" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Done");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
  });
  it("Button renders a link or a typed button with a visible focus style and 44px mobile target", () => {
    const { container } = render(
      <>
        <Button href="/login">Go</Button>
        <Button>Act</Button>
      </>,
    );
    const a = container.querySelector("a");
    const b = container.querySelector("button");
    expect(a?.getAttribute("href")).toBe("/login");
    expect(b?.getAttribute("type")).toBe("button");
    for (const el of [a, b]) {
      expect(el?.className).toContain("min-h-11");
      expect(el?.className).toContain("focus-visible:outline-2");
    }
  });
  it("ShinyButton is focusable, has focus-visible and reduced-motion classes", () => {
    const { getByRole } = render(<ShinyButton href="/login">Sign in</ShinyButton>);
    const a = getByRole("link", { name: "Sign in" });
    a.focus();
    expect(document.activeElement).toBe(a);
    expect(a.className).toContain("shiny-cta");
    expect(a.className).toContain("focus-visible:outline-2");
    expect(a.className).toContain("motion-reduce:animate-none");
  });
  it("StatusChip always shows a text label and an icon", () => {
    const expected: Record<ChipState, string> = { success: "Paid", pending: "Pending", blocked: "Blocked", degraded: "Degraded", revoked: "Revoked" };
    for (const [state, text] of Object.entries(expected) as [ChipState, string][]) {
      const { container } = render(<StatusChip state={state} />);
      expect(container.textContent).toBe(text);
      expect(container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      cleanup();
    }
    expect(render(<StatusChip state="success" label="Custom" />).container.textContent).toBe("Custom");
  });
  it("Starfield is deterministic, fixed-size, decorative and has no style or remote refs", () => {
    const a = markup(render(<Starfield />).container);
    cleanup();
    const { container } = render(<Starfield />);
    expect(markup(container)).toBe(a);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("class")).toContain("pointer-events-none");
    expect(container.querySelectorAll("circle")).toHaveLength(STAR_TOTAL * 2);
    expect(markup(container)).not.toMatch(/style=|https?:|url\(|href=/);
    expect(container.querySelectorAll("g.star-drift-slow, g.star-drift-mid, g.star-drift-fast")).toHaveLength(3);
  });
  it("Globe is decorative, local and rotates only via a reduced-motion-aware class", () => {
    const { container } = render(<Globe />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(markup(container)).not.toMatch(/style=|https?:|url\(|href=/);
    expect(container.querySelectorAll("circle").length).toBe(GLOBE_DOT_COUNT + 1);
    expect(container.querySelector("g")?.getAttribute("class")).toContain("motion-reduce:animate-none");
  });
  it("decorative layers are aria-hidden and not interactive", () => {
    for (const ui of [<GlowOrbs key="g" />, <ScrollProgress key="s" />]) {
      const { container } = render(ui);
      const el = container.firstElementChild;
      expect(el?.getAttribute("aria-hidden")).toBe("true");
      expect(el?.className).toContain("pointer-events-none");
      cleanup();
    }
  });
});

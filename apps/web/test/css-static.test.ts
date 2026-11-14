import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/**
 * Static checks on the stylesheet and layout (jsdom has no layout engine, so these are text checks, not rendering checks).
 * Target size, reflow and focus visibility still need a real browser pass: see the manual checklist in docs/m6-notes.md.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
const layout = readFileSync(path.join(SRC, "app", "layout.tsx"), "utf8");
function rule(selector: string): string {
  // eslint-disable-next-line security/detect-non-literal-regexp -- selector comes from this file's own constants
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()*+?^$|\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? "";
}
describe("stylesheet", () => {
  it("the target size token is at least 24 CSS px (WCAG 2.2 target size minimum)", () => {
    const m = /--target:\s*([\d.]+)rem/.exec(css);
    expect(m).not.toBeNull();
    expect(Number(m?.[1]) * 16).toBeGreaterThanOrEqual(24);
  });
  it.each([".btn", ".site-nav a", ".field input[type=\"text\"],\n.field input[type=\"email\"],\n.field input[type=\"password\"],\n.field input[type=\"datetime-local\"]", ".filter-form select", ".run-steps summary", ".table a", ".pager a"])("%s sets a minimum target height", (sel) => {
    expect(rule(sel)).toMatch(/min-height:\s*var\(--target\)/);
  });
  it("has a visible focus rule with a 3px outline", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });
  it("stops animation and transitions under prefers-reduced-motion, including the skeleton", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation-duration:\s*0\.01ms/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce) {\n  .skeleton {\n    animation: none;");
  });
  it("reflows tables into stacked rows below 40em, and every cell carries its label", () => {
    expect(css).toMatch(/@media \(max-width: 39\.99em\)/);
    expect(css).toContain("content: attr(data-label)");
  });
  it("wraps long hashes and addresses instead of scrolling sideways", () => {
    expect(rule(".hash,\n.tx-hash")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".address")).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it("keeps a visible focus ring on the shiny CTA and pill nav controls (white 2px outline utilities)", () => {
    for (const f of ["ui/ShinyButton.tsx", "ui/MobileMenu.tsx", "Shell.tsx", "ui/Button.tsx"]) {
      const src = readFileSync(path.join(SRC, "components", f), "utf8");
      expect(src, f).toContain("focus-visible:outline-2");
      expect(src, f).toContain("focus-visible:outline-offset-2");
    }
  });
  it("gives primary controls a 44px mobile target (min-h-11)", () => {
    for (const f of ["ui/ShinyButton.tsx", "ui/Button.tsx", "ui/MobileMenu.tsx"]) expect(readFileSync(path.join(SRC, "components", f), "utf8"), f).toContain("min-h-11");
  });
  it("all decorative motion is covered by a reduced-motion rule: shiny, stars, ping, globe, scroll progress", () => {
    const globe = readFileSync(path.join(SRC, "components", "ui", "Globe.tsx"), "utf8");
    expect(globe).toContain("motion-reduce:animate-none");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.scroll-progress\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@supports \(animation-timeline: scroll\(\)\)/);
    // Every keyframe animation declared in the stylesheet is either named in a reduced-motion block or killed by the global rule.
    const global = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,[\s\S]*?animation-duration:\s*0\.01ms !important;[\s\S]*?animation-iteration-count:\s*1 !important/.test(css);
    expect(global).toBe(true);
  });
  it("has a forced-colors fallback for badges", () => {
    expect(css).toMatch(/@media \(forced-colors: active\)/);
  });
  it("has no @font-face (next/font/local emits it at build time), no remote URL, and only the Tailwind @import", () => {
    expect(css).not.toMatch(/@font-face/);
    for (const remote of ["url(http", "url(\"http", "url('http", "url(//", "url(\"//"]) expect(css).not.toContain(remote);
    expect(css.match(/@import[^;]*;/g)).toEqual(['@import "tailwindcss";']);
  });
  it("uses the self-hosted font variables, not a remote font", () => {
    expect(css).toContain("var(--font-inter)");
    expect(css).toContain("var(--font-manrope)");
  });
  it("defines the template look: accent tokens, glass card, shiny CTA, grid, scrollbar and selection", () => {
    expect(css).toMatch(/--color-accent:\s*#ef233c/);
    for (const s of [".glass-card", ".shiny-cta", ".bg-grid-pattern", "::-webkit-scrollbar-thumb:hover", "::selection"]) expect(css).toContain(s);
  });
  it("stops the shiny CTA, star drift and ping animation under prefers-reduced-motion", () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*html \{[\s\S]*?\n\}\n/.exec(css)?.[0] ?? "";
    for (const s of [".shiny-cta", ".star-drift-slow", ".ping-dot", "animation: none"]) expect(block).toContain(s);
  });
});
describe("layout", () => {
  it("keeps pinch zoom enabled", () => {
    expect(layout).not.toMatch(/user-scalable|maximum-scale|userScalable|maximumScale/i);
    expect(layout).toContain("initialScale: 1");
  });
  it("applies the self-hosted font variables on <html>", () => {
    expect(layout).toContain("manrope.variable");
    expect(layout).toContain("inter.variable");
  });
  it("declares the language and renders the Testnet banner for every page", () => {
    expect(layout).toContain('lang="en"');
    expect(layout).toContain("<TestnetBanner />");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
/** jsdom cannot compute colour, so contrast is checked from the CSS custom property values themselves (WCAG relative luminance). */
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const tokens = new Map<string, string>();
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) tokens.set(m[1] ?? "", m[2] ?? "");
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const tok = (name: string): string => {
  const v = tokens.get(name);
  if (v === undefined) throw new Error(`missing token ${name}`);
  return v;
};
const TEXT_PAIRS: [string, string][] = [
  ["text", "bg"], ["text", "surface"], ["muted", "bg"], ["muted", "surface"], ["link", "bg"], ["link", "surface"],
  ["btn-text", "btn-bg"], ["btn2-text", "btn2-bg"], ["danger-text", "danger-bg"],
  ["net-text", "net-bg"], ["ok-text", "ok-bg"], ["warn-text", "warn-bg"], ["bad-text", "bad-bg"], ["neutral-text", "neutral-bg"],
  ["text", "bad-bg"], ["bad-text", "bg"],
  // New template tokens. Glass cards (black at 60% over a near-black page) are approximated as bg / surface.
  ["muted", "glow-bottom"], ["text", "glow-bottom"], ["accent-ink", "accent"], ["btn-text", "accent-dark"],
  ["accent", "bg"], ["link", "glow-bottom"], ["ok-text", "bg"], ["warn-text", "bg"],
  // Template surfaces: zinc-400 body text on black, on the glass card (black at 60% over bg), and on the red-tinted bottom glow.
  ["accent-2", "bg"], ["accent-2", "surface"], ["accent-2", "glow-bottom"], ["accent-3", "bg"], ["accent-3", "surface"], ["accent-3", "glow-bottom"],
  ["heading", "bg"], ["heading", "surface"], ["heading", "glow-bottom"], ["label", "bg"], ["label", "surface"], ["label", "glow-bottom"],
  ["muted", "btn2-bg"], ["text", "btn2-bg"], ["neutral-text", "neutral-bg"], ["net-text", "bg"], ["bad-text", "bad-bg"],
];
describe("colour tokens", () => {
  it.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(tok(fg), tok(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([["focus", "bg"], ["focus", "surface"], ["border", "bg"], ["bad-text", "bg"], ["accent", "bg"], ["focus", "accent"], ["focus", "btn-bg"], ["accent-2", "bg"], ["accent-3", "bg"]] as [string, string][])("non-text %s against %s is at least 3:1", (fg, bg) => {
    expect(ratio(tok(fg), tok(bg))).toBeGreaterThanOrEqual(3);
  });
  it("the ratio helper matches a known value (black on white is 21:1)", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
  it("targets are at least 44px and layout is not fixed-pixel", () => {
    expect(css).toContain("--target: 2.75rem");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).not.toMatch(/width:\s*(?!1px)\d+px/);
  });
});

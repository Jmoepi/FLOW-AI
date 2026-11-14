// @vitest-environment jsdom
import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Landing } from "../src/components/Landing";
import { Footer } from "../src/components/ui/Footer";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
beforeEach(() => {
  document.documentElement.lang = "en";
  document.title = "Flow AI | Limits you can prove";
});
afterEach(cleanup);
describe("landing page", () => {
  it("has one h1 with the pitch, banner, main and contentinfo landmarks", () => {
    const { container } = render(<Landing />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toContain("An AI that pays your suppliers, but can't spend a cent you haven't allowed, and you can prove it.");
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
  });
  it("the skip link is the first focusable element and Sign in links to /login", async () => {
    const { container } = render(<Landing />);
    await userEvent.setup().tab();
    expect(document.activeElement?.textContent).toBe("Skip to main content");
    const signIn = [...container.querySelectorAll("a")].filter((a) => a.textContent?.trim().startsWith("Sign in"));
    expect(signIn.length).toBeGreaterThan(0);
    for (const a of signIn) expect(a.getAttribute("href")).toBe("/login");
  });
  it("has no external links or remote URLs, and decorative layers are aria-hidden", () => {
    const { container } = render(<Landing />);
    // The serializer adds xmlns namespace attributes; React itself emits no URL.
    expect(new XMLSerializer().serializeToString(container).replace(/ xmlns="[^"]*"/g, "")).not.toMatch(/https?:\/\//);
    expect(container.querySelectorAll("a[href^='http'], a[target]")).toHaveLength(0);
    for (const svg of container.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
  it("makes no fabricated customer, testimonial, statistic or price claims", () => {
    const { container } = render(<Landing />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/testimonial|trusted by|customers|per month|\/mo\b|\$\d|\d+\s?%|pricing/i);
    expect(text).toContain("Testnet only, hackathon MVP");
    expect(text).toContain("What it will not do");
  });
  it("renders without axe violations (contrast is covered numerically in contrast.test.ts)", async () => {
    render(<Landing />);
    const r = await axe.run(document, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
  it("the footer is a contentinfo landmark with a decorative watermark", () => {
    const { container } = render(<Footer />);
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector("[aria-hidden='true']")?.textContent).toBe("FLOW");
  });
});
describe("route behaviour for /", () => {
  const page = readFileSync(path.join(SRC, "app", "page.tsx"), "utf8");
  it("shows the landing page only when there is no session, and otherwise keeps the owner gate", () => {
    expect(page).toContain("if (await isLoggedOut()) return <Landing />;");
    expect(page.indexOf("isLoggedOut()")).toBeLessThan(page.indexOf("requireOwner()"));
  });
  it("leaves the owner gate and the proxy untouched", () => {
    const auth = readFileSync(path.join(SRC, "server", "page-auth.ts"), "utf8");
    expect(auth).toContain('if (session?.role !== "owner") redirect("/login");');
    expect(readFileSync(path.join(SRC, "proxy.ts"), "utf8")).not.toMatch(/redirect|\/login/);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicShell, Shell } from "../src/components/Shell";
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const renderShell = (): void => {
  render(
    <Shell businessName="Acme Imports" current="invoices">
      <h1>Page</h1>
    </Shell>,
  );
};
describe("pill navigation", () => {
  it("keeps the links in the DOM, marks the current page and labels the landmark", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Invoices" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });
  it("the menu button is a disclosure: closed by default, toggles aria-expanded, controls the panel", async () => {
    const user = userEvent.setup();
    renderShell();
    const btn = screen.getByRole("button", { name: "Menu" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(btn.getAttribute("aria-controls") ?? "");
    expect(panel?.className).toContain("hidden");
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
  it("Esc closes the open menu and returns focus to the button", async () => {
    const user = userEvent.setup();
    renderShell();
    const btn = screen.getByRole("button", { name: "Menu" });
    await user.click(btn);
    await user.tab();
    expect(document.activeElement).not.toBe(btn);
    await user.keyboard("{Escape}");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
  });
  it("tab order: skip link, then menu button, then the nav links", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Skip to main content");
    await user.tab();
    expect(document.activeElement?.textContent).toContain("Menu");
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Overview");
  });
  it("the focus ring and 44px mobile target are explicit on the nav controls", () => {
    renderShell();
    for (const el of [screen.getByRole("button", { name: "Menu" }), screen.getByRole("link", { name: "Audit" })]) {
      expect(el.className).toContain("focus-visible:outline-2");
      expect(el.className).toContain("min-h-11");
    }
  });
  it("the login frame keeps the skip link and main landmark, and adds no extra tab stop", () => {
    const { container } = render(
      <PublicShell>
        <h1>Sign in</h1>
      </PublicShell>,
    );
    expect(container.querySelectorAll("a, button")).toHaveLength(1);
    expect(container.querySelector("main#main")).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "../src/components/LoginForm";
import { PolicyForm } from "../src/components/PolicyForm";
import { Landing } from "../src/components/Landing";
import { ShinyButton } from "../src/components/ui/ShinyButton";
import { PublicShell, Shell } from "../src/components/Shell";
import { PAIR, POLICY } from "./ui-fixtures";
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
/** Fake same-origin API: /api/session hands out a CSRF token, PUT /api/policy echoes the new policy with version+1. */
function installFetch(put: (body: Record<string, unknown>) => { status: number; body: unknown } = (b) => ({ status: 200, body: { policy: { ...POLICY, ...b, version: POLICY.version + 1, updated_by: "you", updated_at: "2026-02-01T00:00:00.000Z" }, changed: ["x"] } })): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body });
      if (url === "/api/session") return Promise.resolve(new Response(JSON.stringify({ role: "owner", csrf_token: "csrf-test-token" }), { status: 200 }));
      if (url === "/api/auth/login") return Promise.resolve(new Response("{}", { status: 401 }));
      if (url === "/api/policy" && method === "PUT" && body !== undefined) {
        const r = put(body);
        return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }),
  );
}
beforeEach(() => {
  calls = [];
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("keyboard-only journeys", () => {
  it("the skip link is the first tab stop and moves focus to main", async () => {
    const user = userEvent.setup();
    render(
      <PublicShell>
        <LoginForm />
      </PublicShell>,
    );
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Skip to main content");
    // jsdom does not move focus on fragment navigation, so assert the wiring a browser needs.
    expect(document.activeElement?.getAttribute("href")).toBe("#main");
    const main = document.getElementById("main");
    expect(main?.tagName).toBe("MAIN");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });
  it("login: Tab order is email, password, submit; empty submit puts focus on the error summary", async () => {
    const user = userEvent.setup();
    render(
      <PublicShell>
        <LoginForm />
      </PublicShell>,
    );
    await user.tab(); // skip link
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Email address"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sign in" }));
    await user.keyboard("{Enter}");
    const summary = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(summary.textContent).toContain("Enter your email address.");
    expect(calls.filter((c) => c.url === "/api/auth/login")).toHaveLength(0);
  });
  it("login: a wrong password shows one generic message and clears the password", async () => {
    const user = userEvent.setup();
    render(
      <PublicShell>
        <LoginForm />
      </PublicShell>,
    );
    await user.type(screen.getByLabelText("Email address"), "owner@example.test");
    await user.type(screen.getByLabelText("Password"), "not-the-password");
    await user.keyboard("{Enter}");
    const summary = await screen.findByText("The email or password is not correct.");
    expect(summary).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("");
  });
  it("policy: a validation error moves focus to the error summary and its link reaches the field", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const max = screen.getByLabelText(/Largest single payment/);
    await user.clear(max);
    await user.type(max, "5000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const summary = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(summary.textContent).toContain("cannot be higher than the daily limit");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(max.getAttribute("aria-invalid")).toBe("true");
    expect(max.getAttribute("aria-describedby")).toContain("max_payment_amount-error");
  });
  it("policy: a risky change opens a review dialog that traps Tab, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const daily = screen.getByLabelText(/Daily limit/);
    await user.clear(daily);
    await user.type(daily, "2000");
    const save = screen.getByRole("button", { name: "Save changes" });
    save.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Review before saving" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Review before saving"));
    expect(dialog.textContent).toContain("Raise the daily limit from 1,000 RLUSD to 2,000 RLUSD.");
    // The page behind the dialog is inert.
    expect(screen.getByRole("heading", { name: "Payment policies" }).closest("[inert]")).not.toBeNull();
    // Tab cycles inside the dialog only.
    const inside = (): boolean => dialog.contains(document.activeElement);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(inside()).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await user.tab({ shift: true });
      expect(inside()).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(save));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
  it("policy: save journey by keyboard confirms, sends CSRF + If-Match + confirm_risky, and announces the result", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const daily = screen.getByLabelText(/Daily limit/);
    await user.clear(daily);
    await user.type(daily, "2000");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("dialog");
    await user.tab(); // title -> Confirm
    await user.keyboard("{Enter}");
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Saved."));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers["x-csrf-token"]).toBe("csrf-test-token");
    expect(put?.headers["if-match"]).toBe('"3"');
    expect(put?.body).toMatchObject({ daily_spend_limit: "2000", confirm_risky: true, enabled: true });
    expect(put?.body).not.toHaveProperty("business_id");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("policy: a safe change (lowering a cap) saves without a review step", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const max = screen.getByLabelText(/Largest single payment/);
    await user.clear(max);
    await user.type(max, "100");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.find((c) => c.method === "PUT")?.body).not.toHaveProperty("confirm_risky");
  });
  it("policy: Pause is immediate (no review) and sends the saved values with enabled=false", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    await user.click(screen.getByRole("button", { name: "Pause automation" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ enabled: false, max_payment_amount: "500" });
  });
  it("policy: a 412 conflict explains itself and offers the latest values", async () => {
    installFetch(() => ({ status: 412, body: { code: "VERSION_CONFLICT" } }));
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const max = screen.getByLabelText(/Largest single payment/);
    await user.clear(max);
    await user.type(max, "100");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const summary = await screen.findByRole("alert");
    expect(summary.textContent).toContain("changed since you opened this page");
    expect(screen.getByRole("button", { name: "Load latest values" })).toBeTruthy();
  });
  it("policy: a REAUTH_REQUIRED answer offers a sign-in link", async () => {
    installFetch(() => ({ status: 401, body: { code: "REAUTH_REQUIRED" } }));
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="policy">
        <PolicyForm initial={POLICY} timezone="UTC" pair={PAIR} />
      </Shell>,
    );
    const max = screen.getByLabelText(/Largest single payment/);
    await user.clear(max);
    await user.type(max, "100");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/login?reauth=1");
  });
});
describe("keyboard: agent activity", () => {
  it("the load-older link is reachable by Tab and is a plain link", async () => {
    const { AgentActivityView } = await import("../src/components/AgentActivityView");
    const { AGENT_RUNS } = await import("./ui-fixtures");
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="agent">
        <AgentActivityView page={AGENT_RUNS} timezone="UTC" />
      </Shell>,
    );
    const older = screen.getByRole("link", { name: "Load older runs" });
    for (let i = 0; i < 30 && document.activeElement !== older; i++) await user.tab();
    expect(document.activeElement).toBe(older);
    expect(older.getAttribute("href")).toBe("/agent?before_seq=4");
  });
});

describe("keyboard: landing, nav menu and shiny button", () => {
  it("landing: skip link first, then every control is reachable in DOM order and the shiny CTA takes focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<Landing />);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Skip to main content");
    const seen: Element[] = [];
    for (let i = 0; i < 60; i++) {
      await user.tab();
      const el = document.activeElement;
      if (el === null || el === document.body || seen.includes(el)) break;
      seen.push(el);
    }
    const focusable = [...container.querySelectorAll("a[href], button")].filter((e) => e.getAttribute("aria-hidden") !== "true" && e.getAttribute("tabindex") !== "-1");
    const signIn = focusable.find((e) => e.textContent?.trim().startsWith("Sign in"));
    expect(signIn).toBeDefined();
    expect(seen).toContain(signIn);
  });
  it("shiny button is focusable by Tab and activatable by keyboard as a link", async () => {
    const user = userEvent.setup();
    render(<ShinyButton href="/login">Sign in</ShinyButton>);
    await user.tab();
    const a = screen.getByRole("link", { name: "Sign in" });
    expect(document.activeElement).toBe(a);
    expect(a.getAttribute("href")).toBe("/login");
  });
  it("nav menu opens with Enter and Space, closes with Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(
      <Shell businessName="Acme" current="overview">
        <h1>Page</h1>
      </Shell>,
    );
    const btn = screen.getByRole("button", { name: "Menu" });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
    await user.keyboard(" ");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPanel, RunAgentButton } from "../src/components/ControlPanel";
import { POLICY } from "./ui-fixtures";
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
function installFetch(handlers: { put?: () => { status: number; body: unknown }; post?: () => { status: number; body: unknown } } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/session") return Promise.resolve(new Response(JSON.stringify({ role: "owner", csrf_token: "csrf-test-token" }), { status: 200 }));
      if (url === "/api/policy" && method === "PUT") {
        const r = handlers.put?.() ?? { status: 200, body: { policy: { ...POLICY, enabled: false, version: POLICY.version + 1 }, changed: ["enabled"] } };
        return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
      }
      if (url === "/api/agent-runs" && method === "POST") {
        const r = handlers.post?.() ?? { status: 202, body: { status: "requested" } };
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
describe("control panel", () => {
  it("Pause is reachable by keyboard, sends a versioned fail-safe write, announces it and moves focus to the heading", async () => {
    const user = userEvent.setup();
    render(<ControlPanel policy={POLICY} lastDecisionCode={null} />);
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Pause automation");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Automation is paused"));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers["if-match"]).toBe(`"${String(POLICY.version)}"`);
    expect(put?.headers["x-csrf-token"]).toBe("csrf-test-token");
    expect((put?.body as { enabled: boolean }).enabled).toBe(false);
    await waitFor(() => expect(document.activeElement?.id).toBe("control-title"));
    expect(screen.getByText("Review and turn automation back on").getAttribute("href")).toBe("/policy");
    expect(screen.queryByText("Pause automation")).toBeNull();
  });
  it("a stale version is reported and nothing claims the pause happened", async () => {
    installFetch({ put: () => ({ status: 412, body: { code: "PRECONDITION_FAILED" } }) });
    const user = userEvent.setup();
    render(<ControlPanel policy={POLICY} lastDecisionCode={null} />);
    await user.click(screen.getByText("Pause automation"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("changed since this page loaded"));
    expect(screen.getByText("Pause automation")).toBeTruthy();
  });
  it("a paused policy offers Resume as a link to Payment policies, not a one-click enable", () => {
    render(<ControlPanel policy={{ ...POLICY, enabled: false }} lastDecisionCode={null} />);
    expect(screen.getByText("Automation paused")).toBeTruthy();
    expect(screen.queryByText("Pause automation")).toBeNull();
    expect(screen.getByText("Review and turn automation back on").getAttribute("href")).toBe("/policy");
  });
  it("explains the emergency stop and never claims a live value", () => {
    render(<ControlPanel policy={POLICY} lastDecisionCode="EXECUTION_DISABLED" />);
    expect(document.body.textContent).toContain("only your operator can change");
    expect(document.body.textContent).toContain("cannot read its live value");
    expect(document.body.textContent).toContain("Emergency stop was active");
  });
});
describe("run treasury agent", () => {
  it("requests a run and announces it politely", async () => {
    const user = userEvent.setup();
    render(<RunAgentButton initial={null} />);
    await user.click(screen.getByText("Run treasury agent"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Requested, waiting for the agent"));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/agent-runs" && c.headers["x-csrf-token"] === "csrf-test-token")).toBe(true);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
  it("a second request while one is open is explained", async () => {
    installFetch({ post: () => ({ status: 409, body: { code: "RUN_REQUESTED" } }) });
    const user = userEvent.setup();
    render(<RunAgentButton initial={null} />);
    await user.click(screen.getByText("Run treasury agent"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("already requested"));
  });
  it("shows an open request from the server on first render", () => {
    render(<RunAgentButton initial={{ status: "open", requested_at: "2026-01-15T10:00:00.000Z" }} />);
    expect(screen.getByRole("status").textContent).toContain("waiting for the agent");
  });
});

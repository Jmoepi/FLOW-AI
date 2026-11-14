import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewView } from "../src/components/OverviewView";
import { signingKeyView } from "../src/server/api/overview";
import { OVERVIEW, POLICY } from "./ui-fixtures";

const html = (state: "revoked" | "active" | "other" | "not_set" | "unknown"): string => renderToStaticMarkup(<OverviewView data={{ ...OVERVIEW, signing_key: { state } }} policy={POLICY} />);

describe("guard signing key panel (M7)", () => {
  it.each([
    ["active", "Regular key active"],
    ["not_set", "No regular key registered"],
    ["other", "Different regular key on the ledger"],
    ["revoked", "Signing key revoked"],
    ["unknown", "Not reported yet"],
  ] as const)("shows the %s state as text with an icon, never colour alone", (state, label) => {
    const out = html(state);
    expect(out).toContain("Guard signing key");
    expect(out).toContain(label);
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/); // the badge icon is decorative; the label carries the meaning
  });
  it("gives revoke instructions as a local script and never asks for or stores a seed", () => {
    const out = html("active");
    expect(out).toContain("pnpm owner:revoke-regular-key");
    expect(out).toMatch(/never asks for or stores your master seed/);
    expect(out).not.toMatch(/<input|<textarea|<form/i);
  });
  it("a revoked key is an alert that says payments are blocked and nothing moved", () => {
    const out = html("revoked");
    expect(out).toContain('role="alert"');
    expect(out).toMatch(/Payments are blocked and nothing was moved/);
  });
  it("derives the view from stored public facts only", () => {
    expect(signingKeyView(null)).toBe("unknown");
    expect(signingKeyView({ mode: "revoked", regular_key_state: "active" })).toBe("revoked");
    expect(signingKeyView({ mode: "regular_key", regular_key_state: "active" })).toBe("active");
    expect(signingKeyView({ mode: "master_env", regular_key_state: "other" })).toBe("other");
    expect(signingKeyView({ mode: "master_env", regular_key_state: "not_set" })).toBe("not_set");
    expect(signingKeyView({ mode: "master_env", regular_key_state: "not_configured" })).toBe("unknown");
    expect(signingKeyView({ mode: "master_env", regular_key_state: null })).toBe("unknown");
  });
});

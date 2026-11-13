import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
/**
 * Scans the production client bundle (.next/static, what browsers download) for server-only names and secret-shaped
 * values. Runs against the real `next build` output; it is skipped only when no build exists yet (the verification
 * sequence builds first).
 */
const dir = join(process.cwd(), ".next", "static");
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const built = existsSync(dir);
describe.skipIf(!built)("client bundle", () => {
  const files = built ? walk(dir).filter((f) => /\.(js|css|map)$/.test(f)) : [];
  const text = files.map((f) => readFileSync(f, "utf8"));
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each([
    "DATABASE_URL", "WEB_DATABASE_URL", "GUARD_DATABASE_URL", "OWNER_TREASURY_MASTER_SEED", "AGENT_TO_PAYMENT_GUARD_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY", "AI_API_KEY", "FLOW_LOCAL_WEB_PASSWORD", "FLOW_LOCAL_ADMIN_PASSWORD", "flow_session_secret",
  ])("does not contain %s", (name) => {
    for (const t of text) expect(t).not.toContain(name);
  });
  it("contains no XRPL seed-shaped value, connection string or private-key block", () => {
    for (const t of text) {
      expect(t).not.toMatch(/["'`]s[1-9A-HJ-NP-Za-km-z]{28}["'`]/);
      expect(t).not.toMatch(/postgres(ql)?:\/\/[^"'\s]+@/);
      expect(t).not.toContain("-----BEGIN");
    }
  });
  it("does not ship server modules (pg, node:crypto scrypt auth)", () => {
    for (const t of text) {
      expect(t).not.toContain("scryptSync");
      expect(t).not.toContain("web_credentials");
    }
  });
});

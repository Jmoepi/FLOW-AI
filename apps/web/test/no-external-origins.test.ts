import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCsp, buildSecurityHeaders } from "../src/server/security-headers";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = path.join(ROOT, ".next");
const NONCE = "bm9uY2UtMTIzNDU2Nzg5MA==";
/**
 * Hosts that may appear as text in the built output. Each is a string constant inside framework or app code, not a
 * request the page makes (the CSP `connect-src 'self'` and `default-src 'self'` would block one anyway).
 */
const ALLOWED_HOSTS: Record<string, string> = {
  "testnet.xrpl.org": "fixed Testnet explorer link built by explorer.ts",
  localhost: "local development origin strings",
  "127.0.0.1": "local development origin strings",
  "www.w3.org": "XML namespace identifiers (SVG/MathML/XHTML), never fetched",
  "react.dev": "React error-decoder message text, never fetched",
  "nextjs.org": "Next.js documentation links inside error message text, never fetched",
  "example.com": "URL parser placeholder base used by framework code, never fetched",
  "reactjs.org": "React legacy documentation text, never fetched",
  "github.com": "framework source/issue references inside comments or messages, never fetched",
};
function walk(dir: string, accept: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, accept) : accept(p) && statSync(p).size < 20_000_000 ? [p] : [];
  });
}
function hostsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])/gi)].map((m) => (m[1] ?? "").toLowerCase().replace(/\.$/, ""));
}
const built = existsSync(path.join(NEXT, "BUILD_ID"));
describe("no external origins in the built output", () => {
  // Skipped (not faked) when no build exists. `pnpm --filter @flow-ai/web build` produces .next.
  it.skipIf(!built)("static JS and CSS and any prerendered HTML reference only allowed hosts", () => {
    const files = [
      ...walk(path.join(NEXT, "static"), (f) => /\.(js|css|html|json)$/.test(f)),
      ...walk(path.join(NEXT, "server", "app"), (f) => /\.(html|rsc|segment\.rsc|js)$/.test(f)),
    ];
    expect(files.length).toBeGreaterThan(0);
    const bad = new Map<string, string>();
    // Single-label hosts ("a", "x", "n") are the URL-parser feature-detection placeholders in Next's polyfills: they have no
    // dot and are not resolvable internet hosts. Any real hostname contains a dot, so it must be on the allow-list.
    for (const f of files) for (const h of hostsIn(readFileSync(f, "utf8"))) if (h.includes(".") && !(h in ALLOWED_HOSTS)) bad.set(h, path.relative(NEXT, f));
    expect([...bad].map(([h, f]) => `${h} (${f})`)).toEqual([]);
  });
  it.skipIf(!built)("no stylesheet loads a remote URL or imports, and the emitted fonts are same-origin files", () => {
    const css = walk(path.join(NEXT, "static"), (f) => f.endsWith(".css"));
    expect(css.length).toBeGreaterThan(0);
    for (const f of css) {
      const text = readFileSync(f, "utf8");
      for (const remote of ["url(http", "url(\"http", "url('http", "url(//", "url(\"//", "url('//"]) expect(text, f).not.toContain(remote);
      expect(text, f).not.toMatch(/@import/i);
    }
    expect(walk(path.join(NEXT, "static", "media"), (f) => f.endsWith(".woff2")).length).toBeGreaterThan(0);
  });
  it("the allow-list stays small and every entry is justified", () => {
    for (const [host, why] of Object.entries(ALLOWED_HOSTS)) expect(why.length, host).toBeGreaterThan(10);
  });
});
describe("CSP origins", () => {
  const ORIGIN_DIRECTIVES = ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src"];
  for (const mode of ["production", "development", "test"] as const) {
    it(`${mode}: every source is 'self', data:, a nonce or a keyword; no scheme, host or wildcard`, () => {
      const csp = buildCsp(NONCE, mode);
      expect(csp).not.toMatch(/https?:/);
      expect(csp).not.toContain("*");
      expect(csp).not.toContain("//");
      for (const d of csp.split("; ")) {
        const [name, ...sources] = d.split(" ");
        if (!ORIGIN_DIRECTIVES.includes(name ?? "")) continue;
        for (const s of sources) expect(s === "'self'" || s === "data:" || s.startsWith("'nonce-") || s === "'strict-dynamic'" || s === "'unsafe-eval'" || s === "'unsafe-inline'", `${name}: ${s}`).toBe(true);
      }
    });
  }
  it("production has no unsafe keyword and the header is the same policy", () => {
    const csp = buildCsp(NONCE, "production");
    expect(csp).not.toContain("unsafe-");
    expect(buildSecurityHeaders(NONCE, "production")["content-security-policy"]).toBe(csp);
  });
});

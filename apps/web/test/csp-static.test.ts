import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
const tsx = files(SRC).filter((f) => f.endsWith(".tsx"));
describe("strict CSP: nothing in the UI needs an unsafe directive", () => {
  it.each(tsx.map((f) => [path.relative(SRC, f), f] as const))("%s has no inline script, style, handler string or raw HTML", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/\sstyle=\{/);
    expect(src).not.toMatch(/\sstyle="/);
    expect(src).not.toMatch(/<script/i);
    expect(src).not.toMatch(/\son[a-z]+=["']/);
  });
  it("the only absolute URL in the UI code is the fixed Testnet explorer origin", () => {
    for (const f of files(path.join(SRC, "components")).concat(files(path.join(SRC, "app")))) {
      const urls = [...readFileSync(f, "utf8").matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
      for (const u of urls) expect(u.startsWith("https://testnet.xrpl.org/transactions/") || /^https?:\/\/(?:127\.0\.0\.1|localhost)/.test(u), `${f}: ${u}`).toBe(true);
    }
  });
  it("every external link opts out of opener and referrer leakage", () => {
    for (const f of tsx) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/target="_blank"/g)) expect(src.slice(m.index - 200, m.index + 200), f).toContain("noopener noreferrer");
    }
  });
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMatrix, runDeployChecks } from "../../../scripts/lib/deploy-check";
import { BUDGET, formatBytes, summarize, withinBudget } from "../../../scripts/lib/size-summary";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
describe("deploy readiness (static, mirrors pnpm deploy:check)", () => {
  const checks = runDeployChecks(ROOT);
  it("has a meaningful number of checks", () => {
    expect(checks.length).toBeGreaterThanOrEqual(25);
  });
  it.each(checks.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(c.ok, c.detail).toBe(true);
  });
});
describe("env matrix parser", () => {
  const wrap = (rows: string): string => `<!-- env-matrix:start -->\n| Variable | web | guard | agent |\n|---|---|---|---|\n${rows}\n<!-- env-matrix:end -->`;
  it("reads names and level words", () => {
    const { rows, problems } = parseMatrix(wrap("| `A_B` | required | - | forbidden |"));
    expect(problems).toEqual([]);
    expect(rows.get("A_B")).toEqual({ web: "required", guard: "-", agent: "forbidden" });
  });
  it("flags a value in a cell, a bad name and a malformed row", () => {
    expect(parseMatrix(wrap("| `A_B` | postgres://x | - | - |")).problems.length).toBeGreaterThan(0);
    expect(parseMatrix(wrap("| `lower` | required | - | - |")).problems.length).toBeGreaterThan(0);
    expect(parseMatrix(wrap("| `A_B` | required |")).problems.length).toBeGreaterThan(0);
    expect(parseMatrix("no markers").problems).toEqual(["env matrix markers are missing"]);
  });
});
describe("web size summary", () => {
  it("groups by type, finds the largest scripts and compares with the target", () => {
    const s = summarize([
      { path: "chunks/a.js", raw: 1000, gzip: 400 },
      { path: "chunks/b.js", raw: 5000, gzip: 1500 },
      { path: "css/x.css", raw: 700, gzip: 300 },
      { path: "media/f.woff2", raw: 10, gzip: 10 },
    ]);
    expect(s.js).toEqual({ files: 2, raw: 6000, gzip: 1900 });
    expect(s.css).toEqual({ files: 1, raw: 700, gzip: 300 });
    expect(s.other.files).toBe(1);
    expect(s.largestJs[0]?.path).toBe("chunks/b.js");
    expect(withinBudget(s)).toEqual({ js: true, css: true });
    expect(withinBudget(summarize([{ path: "big.js", raw: 9e6, gzip: BUDGET.jsGzipBytes + 1 }])).js).toBe(false);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
  });
});

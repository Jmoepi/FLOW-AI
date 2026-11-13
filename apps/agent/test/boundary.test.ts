import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}
const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));
const FORBIDDEN_PACKAGES = ["@flow-ai/database", "@flow-ai/xrpl-adapter", "@flow-ai/policy-engine", "xrpl", "pg", "pg-pool", "dotenv"];

describe("agent package boundary (AG-6, 13.1B)", () => {
  it("declares no database, ledger, signer or policy dependency at runtime", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const runtime = Object.keys(pkg.dependencies ?? {});
    for (const name of FORBIDDEN_PACKAGES) expect(runtime, name).not.toContain(name);
    // The only workspace dependency is the shared contracts package.
    expect(runtime.filter((n) => n.startsWith("@flow-ai/"))).toEqual(["@flow-ai/contracts"]);
    // Tests may use the database package for fixtures; the source files below must not.
    for (const name of ["pg", "xrpl", "dotenv"]) expect(Object.keys(pkg.devDependencies ?? {}), name).not.toContain(name);
  });

  it("no source file imports a forbidden package", () => {
    for (const f of files) {
      for (const name of FORBIDDEN_PACKAGES) {
        const importsIt = [`from "${name}"`, `from '${name}'`, `from "${name}/`, `from '${name}/`, `import("${name}`, `require("${name}`].some((s) => f.text.includes(s));
        expect(importsIt, `${f.rel} imports ${name}`).toBe(false);
      }
    }
  });

  it("reads no secret file and uses no filesystem or shell access at all", () => {
    for (const f of files) {
      expect(/\.secrets|(?<![A-Za-z])\.env\b/.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f.rel} mentions a secret file`).toBe(false);
      // The transcript writer is the single, path-confined exception (writes only under docs/demo).
      if (f.rel !== "run/transcript.ts") expect(/from\s+["'](?:node:)?fs(?:\/promises)?["']/.test(f.text), `${f.rel} imports fs`).toBe(false);
    }
  });

  it("process.env is read only by config.ts, main.ts and mcp/server-main.ts", () => {
    const allowed = new Set(["config.ts", "main.ts", "mcp/server-main.ts"]);
    for (const f of files) {
      if (allowed.has(f.rel)) continue;
      expect(/process\.env\b/.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f.rel} reads process.env`).toBe(false);
    }
  });

  it("spawns a process only through the MCP SDK transport", () => {
    for (const f of files) expect(/child_process/.test(f.text), `${f.rel} uses child_process`).toBe(false);
  });

  it("hardcodes no model id", () => {
    for (const f of files) expect(/claude-/i.test(f.text), `${f.rel} contains a model id`).toBe(false);
  });
});

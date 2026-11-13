import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGuard, TOKEN, type FakeGuard } from "./helpers/fake-guard";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MAIN = path.join(ROOT, "apps", "agent", "src", "main.ts");
const SERVER_MAIN = path.join(ROOT, "apps", "agent", "src", "mcp", "server-main.ts");
/** The value is a sentinel: it must never appear in any output, only the NAME may. */
const SENTINEL = "sentinel-value-must-not-print-0123456789";
const FORBIDDEN = [
  "DATABASE_URL",
  "GUARD_DATABASE_URL",
  "WEB_DATABASE_URL",
  "XRPL_DEMO_SIGNER_SEED",
  "XRPL_REGULAR_KEY_SEED",
  "OWNER_TREASURY_MASTER_SEED",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "PAYMENT_EXECUTION_ENABLED",
  "DEMO_OWNER_PASSWORD",
  "SOME_PRIVATE_KEY",
] as const;

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
};

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}
/** Spawns a real node child with an exact environment. Closes stdin after `stdinCloseAfterMs` (a stdio server exits then). */
function run(entry: string, env: Record<string, string>, opts: { stdinCloseAfterMs?: number; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: ROOT, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit within ${String(opts.timeoutMs ?? 30_000)} ms`));
    }, opts.timeoutMs ?? 30_000);
    if (opts.stdinCloseAfterMs !== undefined) setTimeout(() => child.stdin.end(), opts.stdinCloseAfterMs);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

let fake: FakeGuard | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("real child processes refuse forbidden credentials", () => {
  for (const name of FORBIDDEN) {
    it(`the tool server exits non-zero when ${name} is set, naming it and never its value`, async () => {
      const r = await run(SERVER_MAIN, { ...BASE_ENV, PAYMENT_GUARD_INTERNAL_URL: "http://127.0.0.1:9", AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, [name]: SENTINEL }, { timeoutMs: 60_000 });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(name);
      expect(r.stderr + r.stdout).not.toContain(SENTINEL);
      expect(r.stdout).toBe("");
    }, 90_000);

    it(`the agent exits with code 2 when ${name} is set, naming it and never its value`, async () => {
      const r = await run(MAIN, { ...BASE_ENV, PAYMENT_GUARD_INTERNAL_URL: "http://127.0.0.1:9", AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, [name]: SENTINEL }, { timeoutMs: 60_000 });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(name);
      expect(r.stderr + r.stdout).not.toContain(SENTINEL);
    }, 90_000);
  }

  it("AGENT_MODE=llm without a key exits 2 immediately and prints no value", async () => {
    const r = await run(MAIN, { ...BASE_ENV, PAYMENT_GUARD_INTERNAL_URL: "http://127.0.0.1:9", AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, AGENT_MODE: "llm", AI_PROVIDER: "anthropic", AI_MODEL: "some-model" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("AI_API_KEY");
    expect(r.stderr).not.toContain(TOKEN);
  }, 30_000);
});

describe("real child processes start with a clean environment", () => {
  it("the tool server starts, serves on stdout only protocol frames (none before a request) and exits cleanly when stdin closes", async () => {
    const r = await run(SERVER_MAIN, { ...BASE_ENV, PAYMENT_GUARD_INTERNAL_URL: "http://127.0.0.1:9", AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN }, { stdinCloseAfterMs: 4000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(TOKEN);
  }, 40_000);

  it("the agent completes a deterministic run against a guard with a minimal environment", async () => {
    fake = await startFakeGuard();
    const r = await run(MAIN, { ...BASE_ENV, PAYMENT_GUARD_INTERNAL_URL: fake.url, AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN }, { timeoutMs: 60_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/paid/i);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  }, 90_000);
});

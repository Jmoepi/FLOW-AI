import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_OUTPUT_SCHEMAS,
  ToolErrorSchema,
} from "@flow-ai/contracts";
import { buildToolServerEnv, loadAgentConfig } from "../src/config";
import { spawnStdioServer, type ToolSession } from "../src/mcp/mcp-client";
import { INVOICE_ID, PAYMENT_ID, TOKEN, startFakeGuard, type FakeGuard } from "./helpers/fake-guard";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_MAIN = path.join(ROOT, "apps", "agent", "src", "mcp", "server-main.ts");
let fake: FakeGuard;
const sessions: ToolSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  await fake.close();
});

/** The exact env the agent hands to the tool server, built from a parent that also holds an AI key. */
function childEnv(): Record<string, string> {
  const parent = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AI_API_KEY: "must-not-pass", AI_MODEL: "m", AGENT_MODE: "llm", AI_PROVIDER: "anthropic" };
  const config = loadAgentConfig({ AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, PAYMENT_GUARD_INTERNAL_URL: fake.url });
  return buildToolServerEnv(config, parent);
}
async function open(): Promise<ToolSession> {
  const s = await spawnStdioServer({ env: childEnv(), cwd: ROOT });
  sessions.push(s);
  return s;
}

describe("MCP stdio round trip (real child process)", () => {
  it("lists exactly the five tools", async () => {
    fake = await startFakeGuard();
    expect((await (await open()).listTools()).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  }, 40_000);

  it("calls each of the five tools and every structured output validates", async () => {
    fake = await startFakeGuard();
    const s = await open();
    const calls: [(typeof AGENT_TOOL_NAMES)[number], Record<string, unknown>][] = [
      ["get_business_snapshot", {}],
      ["list_open_invoices", { limit: 5 }],
      ["get_invoice_details", { invoice_id: INVOICE_ID }],
      ["request_supplier_payment", { invoice_id: INVOICE_ID, idempotency_key: "agent-0123456789abcdef", agent_reason: "Earliest due date." }],
      ["get_payment_status", { payment_id: PAYMENT_ID }],
    ];
    for (const [name, args] of calls) {
      const r = await s.call(name, args);
      expect(r.ok, name).toBe(true);
      expect(AGENT_TOOL_OUTPUT_SCHEMAS[name].safeParse(r.data).success, name).toBe(true);
    }
    expect(fake.requests.filter((q) => q.path === "/internal/payment-requests")).toHaveLength(1);
  }, 40_000);

  it("invalid input and unknown tools come back as tool errors, not crashes", async () => {
    fake = await startFakeGuard();
    const s = await open();
    const bad = await s.call("request_supplier_payment", { invoice_id: INVOICE_ID, idempotency_key: "agent-0123456789abcdef", amount: "1000" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("INVALID_INPUT");
    expect(ToolErrorSchema.safeParse(bad.data).success).toBe(true);
    expect((await s.call("shell", { cmd: "dir" })).error?.code).toBe("UNKNOWN_TOOL");
    expect((await s.call("get_invoice_details", { invoice_id: "not-a-uuid" })).error?.code).toBe("INVALID_INPUT");
    expect(fake.requests.filter((q) => q.path.startsWith("/internal/payment"))).toHaveLength(0);
    // The server survives bad calls.
    expect((await s.call("get_business_snapshot", {})).ok).toBe(true);
  }, 40_000);

  it("the 6th call over the real transport is refused without a guard request", async () => {
    fake = await startFakeGuard();
    const s = await open();
    for (let i = 0; i < 5; i++) await s.call("get_business_snapshot", {});
    const before = fake.requests.length;
    expect((await s.call("get_business_snapshot", {})).error?.code).toBe("TOOL_CALL_LIMIT");
    expect(fake.requests.length).toBe(before);
  }, 40_000);

  it("the environment handed to the child carries no AI key, no database or seed variable", async () => {
    fake = await startFakeGuard();
    const env = childEnv();
    expect(Object.keys(env)).not.toContain("AI_API_KEY");
    expect(Object.keys(env)).not.toContain("AI_MODEL");
    expect(Object.keys(env).filter((k) => /DATABASE|SEED|SERVICE_ROLE|SUPABASE|PRIVATE/i.test(k))).toEqual([]);
    expect(Object.values(env)).not.toContain("must-not-pass");
  });
});

describe("raw protocol framing", () => {
  it("stdout carries only JSON-RPC frames; the child exits cleanly when stdin closes", async () => {
    fake = await startFakeGuard();
    const child = spawn(process.execPath, ["--import", "tsx", SERVER_MAIN], { cwd: ROOT, env: childEnv(), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    const send = (m: unknown): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    await new Promise((r) => setTimeout(r, 4000));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 1500));
    child.stdin.end();
    expect(await exited).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect((JSON.parse(l) as { jsonrpc: string }).jsonrpc, l.slice(0, 80)).toBe("2.0");
    const list = JSON.parse(lines[1]!) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(stderr).not.toContain(TOKEN);
  }, 40_000);
});

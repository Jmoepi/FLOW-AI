import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_NAMES, AGENT_TOOL_OUTPUT_SCHEMAS, ToolErrorSchema, type AgentToolName } from "@flow-ai/contracts";
import { buildToolServerEnv, loadAgentConfig } from "../src/config";
import { INVOICE_ID, PAYMENT_ID, TOKEN, startFakeGuard, type FakeGuard } from "./helpers/fake-guard";
/**
 * M-2: a stock MCP SDK client validates structuredContent against the advertised outputSchema whenever it is present,
 * once listTools has been called. These tests drive the REAL SDK Client over a REAL stdio child, calling listTools
 * FIRST (so the SDK has cached every output validator), then trigger an error for each tool and assert the client
 * returns the result instead of throwing.
 */
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_MAIN = path.join(ROOT, "apps", "agent", "src", "mcp", "server-main.ts");
let fake: FakeGuard;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  await fake.close();
});
async function connect(): Promise<Client> {
  fake = await startFakeGuard();
  const config = loadAgentConfig({ AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, PAYMENT_GUARD_INTERNAL_URL: fake.url });
  const env = buildToolServerEnv(config, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot });
  const c = new Client({ name: "stock-sdk-client", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", SERVER_MAIN], env, stderr: "ignore", cwd: ROOT }));
  client = c;
  await c.listTools(); // FIRST: caches the output validators, which is what used to make errors throw
  return c;
}
interface Raw {
  isError?: boolean;
  structuredContent?: unknown;
  content: { type: string; text?: string }[];
}
const errorOf = (r: Raw): { code: string; message: string } => {
  const text = r.content[0]?.text ?? "";
  const { ok, error } = JSON.parse(text) as { ok: unknown; error: unknown };
  const parsed = ToolErrorSchema.parse({ ok, error });
  return parsed.error;
};
const VALID: Record<AgentToolName, Record<string, unknown>> = {
  get_business_snapshot: {},
  list_open_invoices: { limit: 3 },
  get_invoice_details: { invoice_id: INVOICE_ID },
  request_supplier_payment: { invoice_id: INVOICE_ID, idempotency_key: "agent-0123456789abcdef" },
  get_payment_status: { payment_id: PAYMENT_ID },
};
const INVALID: Record<AgentToolName, Record<string, unknown>> = {
  get_business_snapshot: { extra: 1 },
  list_open_invoices: { limit: 999 },
  get_invoice_details: { invoice_id: "not-a-uuid" },
  request_supplier_payment: { invoice_id: INVOICE_ID, idempotency_key: "agent-0123456789abcdef", amount: "1000" },
  get_payment_status: {},
};
describe("stock SDK client after listTools", () => {
  it("advertises exactly five tools with closed schemas", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  }, 40_000);
  it.each(AGENT_TOOL_NAMES)("%s: invalid arguments come back as an isError result, not a thrown error", async (name) => {
    const c = await connect();
    const r = (await c.callTool({ name, arguments: INVALID[name] })) as Raw;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(errorOf(r).code).toBe("INVALID_INPUT");
  }, 40_000);
  it.each(AGENT_TOOL_NAMES)("%s: a guard 5xx is surfaced as GUARD_UNAVAILABLE without throwing", async (name) => {
    const c = await connect();
    fake.readStatus = 503;
    fake.paymentResponse = { status: 503, body: { error: "down" } };
    const r = (await c.callTool({ name, arguments: VALID[name] })) as Raw;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(errorOf(r).code).toBe("GUARD_UNAVAILABLE");
  }, 40_000);
  it.each(AGENT_TOOL_NAMES)("%s: a guard 4xx is surfaced as GUARD_REJECTED without throwing", async (name) => {
    const c = await connect();
    fake.readStatus = 404;
    fake.paymentResponse = { status: 422, body: { error: "nope" } };
    const r = (await c.callTool({ name, arguments: VALID[name] })) as Raw;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(errorOf(r).code).toBe("GUARD_REJECTED");
  }, 40_000);
  it("a policy-blocked payment is a normal structured result that validates, and the error path still works afterwards", async () => {
    const c = await connect();
    fake.paymentResponse = {
      status: 200,
      body: {
        payment_id: null, status: "blocked", amount: "1", tx_hash: null, failure_code: "DAILY_LIMIT_EXCEEDED", message: "Over the daily limit.",
        policy_decision: { decision_code: "DAILY_LIMIT_EXCEEDED", policy_version: 3 },
      },
    };
    const r = (await c.callTool({ name: "request_supplier_payment", arguments: VALID.request_supplier_payment })) as Raw;
    expect(r.isError).toBeFalsy();
    expect(AGENT_TOOL_OUTPUT_SCHEMAS.request_supplier_payment.safeParse(r.structuredContent).success).toBe(true);
    // The payment limit per run (1) now refuses a second request; that is also an error result and must not throw.
    const again = (await c.callTool({ name: "request_supplier_payment", arguments: { ...VALID.request_supplier_payment, idempotency_key: "agent-fedcba9876543210" } })) as Raw;
    expect(again.isError).toBe(true);
    expect(errorOf(again).code).toBe("PAYMENT_LIMIT_PER_RUN");
  }, 40_000);
  it("an unknown tool name is an error result, not a thrown error", async () => {
    const c = await connect();
    const r = (await c.callTool({ name: "shell", arguments: { cmd: "dir" } })) as Raw;
    expect(r.isError).toBe(true);
    expect(errorOf(r).code).toBe("UNKNOWN_TOOL");
  }, 40_000);
});

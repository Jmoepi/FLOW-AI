import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_TOOL_NAMES } from "@flow-ai/contracts";
import { createGuardClient } from "../src/guard/client";
import { createLogger } from "../src/logger";
import { createToolServer } from "../src/mcp/server";
import { TOKEN, startFakeGuard, type FakeGuard } from "./helpers/fake-guard";

let fake: FakeGuard;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await fake.close();
});

async function listTools(): Promise<{ name: string; description?: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: unknown } }[]> {
  fake = await startFakeGuard();
  const logger = createLogger(() => undefined);
  const server = createToolServer({ guard: createGuardClient({ baseUrl: fake.url, token: TOKEN, logger }), logger });
  const [c, s] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(s), client.connect(c)]);
  return (await client.listTools()).tools as never;
}

describe("the model-facing tool surface", () => {
  it("is exactly the five spec 7.2.D tools", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(tools).toHaveLength(5);
  });

  it("the payment tool accepts only invoice_id, idempotency_key and agent_reason, and closes the object", async () => {
    const pay = (await listTools()).find((t) => t.name === "request_supplier_payment")!;
    expect(Object.keys(pay.inputSchema.properties ?? {}).sort()).toEqual(["agent_reason", "idempotency_key", "invoice_id"]);
    expect(pay.inputSchema.additionalProperties).toBe(false);
  });

  it("no tool lets the model choose money, destination, tenant or network", async () => {
    const banned = ["amount", "destination", "business_id", "currency", "issuer", "tx_blob", "network", "address", "seed", "policy"];
    for (const t of await listTools()) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const b of banned) expect(props, `${t.name}.${b}`).not.toContain(b);
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it("none of the names that do not exist in the spec are offered", async () => {
    const names = (await listTools()).map((t) => t.name);
    for (const n of ["list_payable_invoices", "check_invoice_eligibility", "update_policy", "sign_transaction", "shell", "transfer_funds", "read_file", "query_database"]) {
      expect(names, n).not.toContain(n);
    }
  });

  it("descriptions carry no environment, token or path text", async () => {
    const text = JSON.stringify(await listTools());
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/DATABASE_URL|SEED|\.secrets|C:\\\\|node_modules/i);
  });
});

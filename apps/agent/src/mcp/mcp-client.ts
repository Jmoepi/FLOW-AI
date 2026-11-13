import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ToolErrorSchema, type ToolError } from "@flow-ai/contracts";

export interface ToolCallResult {
  ok: boolean;
  /** Success: the validated structured payload. Failure: the ToolError envelope. */
  data: Record<string, unknown>;
  error?: ToolError["error"];
}

export interface ToolSession {
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/** Error results carry the envelope as JSON text (no structuredContent); anything that does not parse is a generic failure. */
function parseErrorContent(content: unknown): ToolError | null {
  if (!Array.isArray(content)) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  try {
    const { ok, error } = JSON.parse(first.text) as { ok?: unknown; error?: unknown };
    const parsed = ToolErrorSchema.safeParse({ ok, error });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function wrap(client: Client, closeExtra: () => Promise<void>): ToolSession {
  return {
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async call(name, args, opts) {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        ...(opts?.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (res.isError === true) {
        const parsed = parseErrorContent(res.content);
        return parsed === null ? { ok: false, data: {}, error: { code: "INTERNAL", message: "The tool failed." } } : { ok: false, data: parsed, error: parsed.error };
      }
      return { ok: true, data: (res.structuredContent ?? {}) as Record<string, unknown> };
    },
    async close() {
      await client.close();
      await closeExtra();
    },
  };
}

/** Fast path for unit tests: client and server linked in memory. */
export async function connectInProcess(server: Server): Promise<ToolSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "flow-ai-agent", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return wrap(client, () => server.close());
}

const SERVER_MAIN = fileURLToPath(new URL("./server-main.ts", import.meta.url));

export interface SpawnOptions {
  /** The COMPLETE environment of the child. Nothing is inherited from the parent. */
  env: Record<string, string>;
  cwd?: string;
}

/** Real path: the tool server runs as a child process over stdio with an explicit minimal env (spec 7.3). */
export async function spawnStdioServer(opts: SpawnOptions): Promise<ToolSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", SERVER_MAIN],
    env: opts.env,
    stderr: "inherit",
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  const client = new Client({ name: "flow-ai-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return wrap(client, () => Promise.resolve());
}

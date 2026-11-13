import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolErrorSchema, redactError, type ToolError, type ToolErrorCode } from "@flow-ai/contracts";
import { GuardError, type GuardClient } from "../guard/client";
import { createLogger, type Logger } from "../logger";
import { DATA_NOTICE, TOOL_BY_NAME, TOOLS } from "./tools";

export interface ToolLimits {
  /** Calls allowed in this session, including refused ones (default 5). */
  maxToolCalls: number;
  /** request_supplier_payment calls allowed in this session (default 1). */
  maxPayments: number;
}
export const DEFAULT_LIMITS: ToolLimits = { maxToolCalls: 5, maxPayments: 1 };

export interface ToolServerOptions {
  guard: GuardClient;
  limits?: ToolLimits;
  logger?: Logger;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Errors carry text content only. The MCP SDK client validates `structuredContent` against the advertised outputSchema
 * whenever it is present (even with isError), so an error envelope there would make every error throw after listTools.
 * A result with isError and no structuredContent is accepted without validation.
 */
function errorResult(code: ToolErrorCode, message: string): ToolResult {
  const payload: ToolError = ToolErrorSchema.parse({ ok: false, error: { code, message } });
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ data_notice: DATA_NOTICE, ...payload }) }] };
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ data_notice: DATA_NOTICE, ...payload }) }], structuredContent: payload };
}

/** Zod issue paths only: values are never echoed (they may be hostile text). */
function issuePaths(err: z.ZodError): string {
  const paths = [...new Set(err.issues.map((i) => (i.path.length ? i.path.map(String).join(".") : "(input)")))].slice(0, 5);
  return `Invalid input: ${paths.join(", ")}.`;
}

/**
 * One server instance is one agent session: it owns the call counters. The model-facing surface is exactly the five
 * tools in TOOLS. Bounds are enforced here as well as in the agent loop, so a hostile loop cannot exceed them.
 */
export function createToolServer(opts: ToolServerOptions): Server {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const log = opts.logger ?? createLogger();
  let calls = 0;
  let payments = 0;

  const server = new Server({ name: "flow-ai-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }) as { type: "object"; [k: string]: unknown },
      outputSchema: z.toJSONSchema(t.output, { target: "draft-7" }) as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<ToolResult> => {
    const started = Date.now();
    const name = req.params.name;
    const done = (result: ToolResult, code?: string): ToolResult => {
      log.info("tool.call", { tool: TOOL_BY_NAME.has(name) ? name : "(unknown)", ok: result.isError !== true, ...(code ? { code } : {}), duration_ms: Date.now() - started });
      return result;
    };
    const fail = (code: ToolErrorCode, message: string): ToolResult => done(errorResult(code, message), code);

    calls += 1;
    if (calls > limits.maxToolCalls) return fail("TOOL_CALL_LIMIT", "Tool call limit reached for this run. No further tool calls are allowed.");
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return fail("UNKNOWN_TOOL", "That tool does not exist.");
    if (tool.name === "request_supplier_payment" && payments >= limits.maxPayments) {
      return fail("PAYMENT_LIMIT_PER_RUN", "Only one payment request is allowed per run.");
    }
    const parsed = tool.input.safeParse(req.params.arguments ?? {});
    if (!parsed.success) return fail("INVALID_INPUT", issuePaths(parsed.error));
    if (tool.name === "request_supplier_payment") payments += 1;

    try {
      const raw = await tool.handler(parsed.data as never, { guard: opts.guard, signal: extra.signal });
      const out = tool.output.safeParse(raw);
      if (!out.success) {
        log.error("tool.output_invalid", { tool: tool.name });
        return fail("INTERNAL", "The tool produced an unexpected result.");
      }
      return done(okResult(out.data as Record<string, unknown>));
    } catch (err) {
      if (err instanceof GuardError) return fail(err.code, err.message);
      log.error("tool.internal_error", { tool: tool.name, error: redactError(err) });
      return fail("INTERNAL", "The tool failed.");
    }
  });

  return server;
}

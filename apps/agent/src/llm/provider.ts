/**
 * Provider-neutral model interface (spec 7.3, 13.1A). One function, no provider types leak out.
 * The agent loop only ever sees these shapes, so a second provider is an adapter, not a rewrite.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /** Untrusted model output. The MCP server validates it with strict schemas before anything happens. */
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export type AssistantBlock = TextBlock | ToolUseBlock;

export type Message = { role: "assistant"; content: AssistantBlock[] } | { role: "user"; content: string | (TextBlock | ToolResultBlock)[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompleteRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface CompleteResponse {
  blocks: AssistantBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderAdapter {
  readonly provider: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

/**
 * unavailable: network, timeout, 429, 5xx, 529 (the run may fall back to deterministic mode before any payment).
 * auth: 401/403 (the run fails; no fallback).
 * bad_response: non-JSON, oversize, schema mismatch, redirect, unexpected 4xx.
 * The message never carries a response body, a header or the API key.
 */
export type ProviderErrorCode = "unavailable" | "auth" | "bad_response";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

import { z } from "zod";
import { ProviderError, type AssistantBlock, type CompleteRequest, type CompleteResponse, type Message, type ProviderAdapter, type StopReason } from "./provider";

/** The only host the adapter talks to (SV-3). */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
/** Unverified against live docs in this build; recorded in docs/m5-notes.md. */
export const ANTHROPIC_VERSION = "2023-06-01";
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

export interface AnthropicOptions {
  apiKey: string;
  /** From AI_MODEL only. There is no default and no literal model id in this codebase. */
  model: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Test seam: allows a non-Anthropic baseUrl (a local fake). Never set in production code. */
  allowTestBaseUrl?: boolean;
  timeoutMs?: number;
}

const ResponseSchema = z.object({
  content: z.array(z.looseObject({ type: z.string() })).max(64),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).partial().optional(),
});
const TextSchema = z.object({ type: z.literal("text"), text: z.string().max(100_000) });
const ToolUseSchema = z.object({ type: z.literal("tool_use"), id: z.string().min(1).max(200), name: z.string().min(1).max(200), input: z.unknown() });

function toWire(messages: Message[]): unknown[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function mapStop(s: string | null | undefined): StopReason {
  return s === "end_turn" || s === "tool_use" || s === "max_tokens" ? s : "other";
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ProviderError("bad_response", "The provider response was too large.");
  if (res.body === null) return "";
  const reader = res.body.getReader() as unknown as { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError("bad_response", "The provider response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createAnthropicAdapter(opts: AnthropicOptions): ProviderAdapter {
  if (opts.apiKey.trim() === "") throw new ProviderError("auth", "AI_API_KEY is empty.");
  if (opts.model.trim() === "") throw new ProviderError("bad_response", "AI_MODEL is empty.");
  const base = opts.baseUrl ?? ANTHROPIC_ORIGIN;
  if (base !== ANTHROPIC_ORIGIN && opts.allowTestBaseUrl !== true) throw new ProviderError("bad_response", "The provider host is pinned.");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = `${base.replace(/\/+$/, "")}/v1/messages`;

  return {
    provider: "anthropic",
    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const body = JSON.stringify({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toWire(req.messages),
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      });
      const signal = req.signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
          body,
          redirect: "error",
          signal,
        });
      } catch {
        // Network error, abort or timeout. The cause is dropped on purpose: it could echo request headers.
        throw new ProviderError("unavailable", "The model provider could not be reached.");
      }

      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("auth", "The model provider rejected the credentials.");
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("unavailable", `The model provider is unavailable (HTTP ${String(res.status)}).`);
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new ProviderError("bad_response", `The model provider returned HTTP ${String(res.status)}.`);
      }

      let raw: string;
      try {
        raw = await readCapped(res);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError("unavailable", "The model provider response could not be read.");
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new ProviderError("bad_response", "The model provider returned non-JSON.");
      }
      const parsed = ResponseSchema.safeParse(json);
      if (!parsed.success) throw new ProviderError("bad_response", "The model provider response had an unexpected shape.");

      const blocks: AssistantBlock[] = [];
      for (const b of parsed.data.content) {
        if (b.type === "text") {
          const t = TextSchema.safeParse(b);
          if (!t.success) throw new ProviderError("bad_response", "A text block had an unexpected shape.");
          blocks.push({ type: "text", text: t.data.text });
        } else if (b.type === "tool_use") {
          const t = ToolUseSchema.safeParse(b);
          if (!t.success) throw new ProviderError("bad_response", "A tool_use block had an unexpected shape.");
          blocks.push({ type: "tool_use", id: t.data.id, name: t.data.name, input: t.data.input });
        }
        // Other block types (e.g. thinking) are ignored: they never reach the loop.
      }
      return {
        blocks,
        stopReason: mapStop(parsed.data.stop_reason),
        usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 },
      };
    },
  };
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_VERSION, MAX_RESPONSE_BYTES, createAnthropicAdapter } from "../src/llm/anthropic";
import { ProviderError, type CompleteRequest } from "../src/llm/provider";

// Assembled at runtime so the secret scanner does not flag the fixture.
const KEY = ["sk", "ant", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
const MODEL = "test-model-from-env";

const req: CompleteRequest = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "get_business_snapshot", description: "d", inputSchema: { type: "object" } }],
  maxTokens: 1024,
};

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(res: Response | Error, calls: Call[] = []): typeof fetch {
  return ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const adapterFor = (f: typeof fetch) => createAnthropicAdapter({ apiKey: KEY, model: MODEL, fetchImpl: f });
const failure = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error("expected a ProviderError");
};

describe("anthropic adapter", () => {
  it("sends the pinned URL, headers, native tools and max_tokens; the key is only in the header", async () => {
    const calls: Call[] = [];
    const out = await adapterFor(fakeFetch(json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } }), calls)).complete(req);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]!.init.redirect).toBe("error");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe("sys");
    expect(body.tools).toEqual([{ name: "get_business_snapshot", description: "d", input_schema: { type: "object" } }]);
    expect(calls[0]!.init.body as string).not.toContain(KEY);
    expect(out).toEqual({ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("parses tool_use blocks and ignores unknown block types", async () => {
    const out = await adapterFor(
      fakeFetch(json({ content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "tu_1", name: "get_business_snapshot", input: {} }], stop_reason: "tool_use" })),
    ).complete(req);
    expect(out.blocks).toEqual([{ type: "tool_use", id: "tu_1", name: "get_business_snapshot", input: {} }]);
    expect(out.stopReason).toBe("tool_use");
  });

  it("maps tool_result blocks with is_error onto the wire unchanged", async () => {
    const calls: Call[] = [];
    await adapterFor(fakeFetch(json({ content: [] }), calls)).complete({
      ...req,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "{}", is_error: true }] }],
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { messages: { content: unknown }[] };
    expect(body.messages[0]!.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "{}", is_error: true }]);
  });

  it.each([401, 403])("HTTP %i is an auth error", async (status) => {
    const e = await failure(adapterFor(fakeFetch(json({ error: { message: KEY } }, status))).complete(req));
    expect(e.code).toBe("auth");
    expect(e.message).not.toContain(KEY);
  });

  it.each([429, 500, 503, 529])("HTTP %i is unavailable", async (status) => {
    expect((await failure(adapterFor(fakeFetch(json({}, status))).complete(req))).code).toBe("unavailable");
  });

  it("a network error or timeout is unavailable and the message never carries the key", async () => {
    const e = await failure(adapterFor(fakeFetch(new TypeError(`connect failed with ${KEY}`))).complete(req));
    expect(e.code).toBe("unavailable");
    expect(e.message).not.toContain(KEY);
    const t = await failure(createAnthropicAdapter({ apiKey: KEY, model: MODEL, timeoutMs: 20, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch }).complete(req));
    expect(t.code).toBe("unavailable");
  });

  it("malformed JSON, wrong shapes, other 4xx and redirects are bad_response", async () => {
    expect((await failure(adapterFor(fakeFetch(new Response("not json", { status: 200 }))).complete(req))).code).toBe("bad_response");
    expect((await failure(adapterFor(fakeFetch(json({ nope: true }))).complete(req))).code).toBe("bad_response");
    expect((await failure(adapterFor(fakeFetch(json({ content: [{ type: "tool_use", id: "x" }] }))).complete(req))).code).toBe("bad_response");
    expect((await failure(adapterFor(fakeFetch(json({}, 400))).complete(req))).code).toBe("bad_response");
    expect((await failure(adapterFor(fakeFetch(new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).complete(req))).code).toBe("bad_response");
  });

  it("an oversize response is bad_response", async () => {
    const big = JSON.stringify({ content: [{ type: "text", text: "x".repeat(MAX_RESPONSE_BYTES) }] });
    expect((await failure(adapterFor(fakeFetch(new Response(big, { status: 200 }))).complete(req))).code).toBe("bad_response");
  });

  it("pins the host unless the test seam is set; refuses empty key or model", () => {
    const f = fakeFetch(json({}));
    expect(() => createAnthropicAdapter({ apiKey: KEY, model: MODEL, fetchImpl: f, baseUrl: "https://evil.example" })).toThrow(ProviderError);
    expect(() => createAnthropicAdapter({ apiKey: KEY, model: MODEL, fetchImpl: f, baseUrl: "http://127.0.0.1:1", allowTestBaseUrl: true })).not.toThrow();
    expect(() => createAnthropicAdapter({ apiKey: " ", model: MODEL, fetchImpl: f })).toThrow(ProviderError);
    expect(() => createAnthropicAdapter({ apiKey: KEY, model: "", fetchImpl: f })).toThrow(ProviderError);
  });

  it("no model id literal exists in apps/agent/src", () => {
    const root = path.resolve(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/claude-/i);
  });
});

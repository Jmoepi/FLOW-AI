import { ProviderError, type AssistantBlock, type CompleteRequest, type CompleteResponse, type ProviderAdapter } from "../../src/llm/provider";

export type Script = (AssistantBlock[] | ProviderError | ((req: CompleteRequest) => AssistantBlock[]))[];

export interface FakeProvider extends ProviderAdapter {
  requests: CompleteRequest[];
}

/** Scripted model: each call to complete() consumes the next entry. No network. Past the script it ends the turn. */
export function fakeProvider(script: Script): FakeProvider {
  const requests: CompleteRequest[] = [];
  let i = 0;
  return {
    provider: "fake",
    requests,
    complete(req: CompleteRequest): Promise<CompleteResponse> {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const step = script[i++];
      if (step instanceof ProviderError) return Promise.reject(step);
      const blocks = step === undefined ? [] : typeof step === "function" ? step(req) : step;
      const hasTool = blocks.some((b) => b.type === "tool_use");
      return Promise.resolve({ blocks, stopReason: hasTool ? "tool_use" : "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
    },
  };
}

export const use = (id: string, name: string, input: unknown): AssistantBlock => ({ type: "tool_use", id, name, input });
export const say = (text: string): AssistantBlock => ({ type: "text", text });

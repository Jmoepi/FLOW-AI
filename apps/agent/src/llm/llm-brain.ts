import { z } from "zod";
import { PaymentResultSchema, PaymentStatusOutputSchema, sanitizeText, type AgentToolName, type PaymentResult } from "@flow-ai/contracts";
import { DATA_NOTICE, TOOLS } from "../mcp/tools";
import { outcomeFor } from "../run/deterministic";
import { idempotencyKeyFor } from "../run/choose";
import { RecorderError } from "../run/recorder";
import type { Brain, BrainContext, BrainOutcome } from "../run/types";
import { ProviderError, type Message, type ProviderAdapter, type ToolResultBlock, type ToolSpec } from "./provider";
import { FIRST_USER_MESSAGE, SYSTEM_PROMPT } from "./system-prompt";

const MAX_TOKENS = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Native tool definitions for the model, from the same strict schemas the MCP server enforces. */
export function buildToolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }),
  }));
}

export interface LlmBrainOptions {
  adapter: ProviderAdapter;
  /** Used only when the provider is unavailable BEFORE any payment request (spec 13.2). Never silent. */
  fallback: Brain;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * LLM brain. The model proposes tool calls; every call goes through the SAME tool session as the deterministic
 * brain, so the MCP server's allowlist, strict schemas and bounds apply, and the guard decides. Model text is
 * recorded (sanitised, 280 chars) and never executed or used to build a request.
 */
export function createLlmBrain(opts: LlmBrainOptions): Brain {
  const tools = buildToolSpecs();
  return {
    mode: "llm",
    async run(ctx: BrainContext): Promise<BrainOutcome> {
      const messages: Message[] = [{ role: "user", content: FIRST_USER_MESSAGE }];
      const maxTurns = ctx.config.maxToolCalls + 2;
      let paymentRequested = false;
      let lastPayment: PaymentResult | null = null;
      let candidate: string | undefined;
      let sentReason: string | undefined;
      let limitHit = false;

      const finish = (): BrainOutcome => {
        if (lastPayment !== null && candidate !== undefined) return outcomeFor(lastPayment, candidate, sentReason ?? "LLM agent requested payment.");
        if (paymentRequested) {
          return { status: "failed", summary: "The payment request did not return a result. Check the payment status before retrying.", ...(candidate === undefined ? {} : { candidateInvoiceId: candidate }) };
        }
        if (limitHit) return { status: "limit_exceeded", summary: "A run limit stopped the agent. No payment was requested." };
        return { status: "no_candidate", summary: "The model ended the run without requesting a payment. No funds were moved." };
      };

      for (let turn = 0; turn < maxTurns; turn++) {
        if (ctx.signal.aborted || ctx.remainingMs() <= 0) return { status: "timed_out", summary: "The run exceeded its time limit. Check the payment status before retrying." };

        let resp;
        try {
          resp = await opts.adapter.complete({ system: SYSTEM_PROMPT, messages, tools, maxTokens: MAX_TOKENS, signal: ctx.signal });
        } catch (err) {
          const code = err instanceof ProviderError ? err.code : "bad_response";
          if (ctx.signal.aborted) return { status: "timed_out", summary: "The run exceeded its time limit. Check the payment status before retrying." };
          if (code === "unavailable" && !paymentRequested) {
            ctx.logger.warn("run.mode_fallback", { from: "llm", to: "deterministic", reason: code });
            await ctx.recorder.event({ kind: "mode_fallback", output: { from: "llm", to: "deterministic", reason: code } });
            const out = await opts.fallback.run(ctx);
            return { ...out, effectiveMode: "deterministic" };
          }
          if (paymentRequested) return finish();
          return {
            status: "failed",
            summary: code === "auth" ? "The model provider rejected the credentials. No payment was requested." : "The model provider gave an unusable response. No payment was requested.",
          };
        }

        const text = resp.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
        if (text.trim() !== "") await ctx.recorder.event({ kind: "model_turn", output: { text: sanitizeText(text, 280) } });
        messages.push({ role: "assistant", content: resp.blocks });

        const uses = resp.blocks.flatMap((b) => (b.type === "tool_use" ? [b] : []));
        if (uses.length === 0) break;

        const results: ToolResultBlock[] = [];
        for (const use of uses) {
          const send = (content: unknown, isError: boolean): void => {
            results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(content), is_error: isError });
          };
          // Unknown tool names still go through the session so the server refuses and counts them.
          let args = asRecord(use.input);
          if (use.name === "request_supplier_payment") {
            // The key is never model-controlled: deterministic per (run, invoice) so a retried run cannot double pay.
            if (typeof args.invoice_id === "string" && UUID_RE.test(args.invoice_id)) args = { ...args, idempotency_key: idempotencyKeyFor(ctx.runId, args.invoice_id) };
            const reason = typeof args.agent_reason === "string" ? sanitizeText(args.agent_reason, ctx.config.reasonMaxChars).trim() : undefined;
            try {
              // Fail closed: if the intent cannot be recorded, the payment is not requested.
              await ctx.recorder.intent({
                kind: "tool_call",
                tool_name: "request_supplier_payment",
                input: { invoice_id: str(args.invoice_id, 64), idempotency_key: str(args.idempotency_key, 128), ...(reason === undefined ? {} : { agent_reason: reason }) },
              });
            } catch (err) {
              if (err instanceof RecorderError) return { status: "failed", summary: "The run record could not be written, so no payment was requested." };
              throw err;
            }
          }

          const res = await ctx.callTool(use.name as AgentToolName, args);
          const code = res.error?.code;

          if (use.name === "request_supplier_payment" && code !== "TOOL_CALL_LIMIT" && code !== "PAYMENT_LIMIT_PER_RUN" && code !== "INVALID_INPUT" && code !== "RUN_TIMEOUT") {
            paymentRequested = true;
            if (typeof args.invoice_id === "string") candidate = args.invoice_id;
            sentReason = typeof args.agent_reason === "string" ? sanitizeText(args.agent_reason, ctx.config.reasonMaxChars).trim() : undefined;
          }
          if (res.ok && use.name === "request_supplier_payment") {
            const p = PaymentResultSchema.safeParse(res.data);
            if (p.success) lastPayment = p.data;
          }
          if (res.ok && use.name === "get_payment_status" && lastPayment?.payment_id !== null && lastPayment?.payment_id !== undefined) {
            const s = PaymentStatusOutputSchema.safeParse(res.data);
            const latest = s.success ? s.data.payments[0] : undefined;
            if (latest !== undefined && latest.payment_id === lastPayment.payment_id) lastPayment = { ...latest, decision_code: latest.decision_code ?? lastPayment.decision_code };
          }
          if (code === "TOOL_CALL_LIMIT") limitHit = true;
          if (code === "PAYMENT_LIMIT_PER_RUN") limitHit = true;
          send(res.ok ? { data_notice: DATA_NOTICE, ...res.data } : res.data, !res.ok);
        }
        messages.push({ role: "user", content: results });

        if (limitHit && lastPayment === null) return finish();
        // A block is final: no retry, no second attempt on another invoice.
        if (lastPayment !== null && lastPayment.status === "blocked") break;
      }
      return finish();
    },
  };
}

import type { AgentMode, AgentRunEvent, AgentRunFinish, AgentToolName, AgentTrigger } from "@flow-ai/contracts";
import type { ToolCallResult, ToolSession } from "../mcp/mcp-client";
import type { Recorder } from "./recorder";
import type { AgentConfig } from "../config";
import type { Logger } from "../logger";

/** `skipped`: the guard already has a running run for this business (409). No tool was called. */
export type RunStatus = AgentRunFinish["client_status"] | "skipped";

export interface RunResult {
  status: RunStatus;
  summary: string;
  runId: string | null;
  mode: AgentMode;
  effectiveMode: AgentMode;
  trigger: AgentTrigger;
  toolCallCount: number;
  candidateInvoiceId: string | null;
  paymentId: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  decisionCode: string | null;
  agentReason: string | null;
  events: AgentRunEvent[];
}

/** What a brain decides. The loop turns it into a recorded, finished run. */
export interface BrainOutcome {
  status: Exclude<RunStatus, "skipped" | "interrupted">;
  summary: string;
  candidateInvoiceId?: string | undefined;
  paymentId?: string | undefined;
  txHash?: string | undefined;
  explorerUrl?: string | undefined;
  decisionCode?: string | undefined;
  agentReason?: string | undefined;
  /** Set when the brain ran in a different mode than requested (visible fallback). */
  effectiveMode?: AgentMode | undefined;
}

export interface BrainContext {
  runId: string;
  config: AgentConfig;
  recorder: Recorder;
  logger: Logger;
  signal: AbortSignal;
  probeIneligible: boolean;
  /** Milliseconds left in the whole-run budget. */
  remainingMs(): number;
  /**
   * The only way a brain reaches a tool. Enforces the loop-side bound (the MCP server enforces it again), applies the
   * per-tool timeout and records a `tool_call` event with a small redacted projection.
   */
  callTool(name: AgentToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** Tool calls made so far in this run, including refused ones. */
  toolCallCount(): number;
}

export interface Brain {
  readonly mode: AgentMode;
  run(ctx: BrainContext): Promise<BrainOutcome>;
}

export interface RunAgentOptions {
  config: AgentConfig;
  recorder: Recorder;
  tools: ToolSession;
  brain: Brain;
  trigger: AgentTrigger;
  probeIneligible?: boolean;
  logger?: Logger;
  /** Aborts the whole run (SIGINT). */
  signal?: AbortSignal;
}

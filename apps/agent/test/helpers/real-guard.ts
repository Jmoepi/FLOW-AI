import path from "node:path";
import type { AddressInfo } from "node:net";
import { insertSnapshot } from "@flow-ai/database";
import type { Scenario, ScenarioOptions } from "@flow-ai/database/testing";
import { createHarness, type Harness, type HarnessOptions } from "../../../payment-guard/test/db-harness";
import { TOKEN } from "../../../payment-guard/test/helpers";
import { buildToolServerEnv, loadAgentConfig } from "../../src/config";
import { createGuardClient } from "../../src/guard/client";
import { createLogger } from "../../src/logger";
import { connectInProcess, spawnStdioServer, type ToolSession } from "../../src/mcp/mcp-client";
import { createToolServer } from "../../src/mcp/server";
import { createDeterministicBrain } from "../../src/run/deterministic";
import { createRecorder } from "../../src/run/recorder";
import { runAgent } from "../../src/run/run-agent";
import type { Brain, RunResult } from "../../src/run/types";

export { TOKEN };
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

/** The real payment guard (real Postgres, real HTTP socket, scriptable fake ledger) plus a place to collect agent-side logs. */
export interface Stack {
  h: Harness;
  url: string;
  /** Everything the agent side logged. Scanned for the bearer token at the end. */
  agentLogs: string[];
  close(): Promise<void>;
}

export async function startStack(options: HarnessOptions = {}): Promise<Stack> {
  const h = await createHarness(options);
  await h.guard.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.guard.app.server.address() as AddressInfo).port;
  return { h, url: `http://127.0.0.1:${String(port)}`, agentLogs: [], close: () => h.close() };
}

/** A fresh tenant with a fresh balance snapshot, pinned as THE business of this guard (like GUARD_BUSINESS_ID). */
export async function newBusiness(stack: Stack, opts: Partial<ScenarioOptions> = {}): Promise<Scenario> {
  const s = await stack.h.scenario(opts);
  stack.h.config.businessId = s.businessId;
  await insertSnapshot(stack.h.db.guardPool, { wallet_id: s.walletId, rlusd_balance: "100", xrp_balance: "100", ledger_index: 1000 });
  return s;
}

export interface SeenRequest {
  method: string;
  path: string;
  status: number;
}
/** A recording fetch: what actually went over the wire to the guard, and what came back. */
export function spyFetch(): { fetchImpl: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const res = await fetch(input, init);
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, status: res.status });
    return res;
  };
  return { fetchImpl, seen };
}

export interface AgentRunOptions {
  /** Spawn the real stdio MCP server child instead of the in-memory pair. */
  stdio?: boolean;
  probe?: boolean;
  brain?: Brain;
  /** Spy on the TOOL server's requests (the model-facing surface). */
  toolFetch?: typeof fetch;
  /** Spy on every request the recorder makes. */
  recorderFetch?: typeof fetch;
  timeoutSeconds?: string;
}

export function agentConfig(stack: Stack, extra: Record<string, string> = {}) {
  return loadAgentConfig({ AGENT_TO_PAYMENT_GUARD_TOKEN: TOKEN, PAYMENT_GUARD_INTERNAL_URL: stack.url, ...extra });
}

/** One full agent run against the real guard: fresh tool server (fresh per-session bounds), fresh recorder. */
export async function agentRun(stack: Stack, o: AgentRunOptions = {}): Promise<RunResult> {
  const logger = createLogger((l) => stack.agentLogs.push(l));
  const config = agentConfig(stack, o.timeoutSeconds === undefined ? {} : { AGENT_RUN_TIMEOUT_SECONDS: o.timeoutSeconds });
  const recorderGuard = createGuardClient({ baseUrl: stack.url, token: TOKEN, logger, ...(o.recorderFetch ? { fetchImpl: o.recorderFetch } : {}) });
  const session = await openTools(stack, { stdio: o.stdio ?? false, ...(o.toolFetch ? { fetchImpl: o.toolFetch } : {}) });
  try {
    return await runAgent({ config, recorder: createRecorder(recorderGuard, logger), tools: session, brain: o.brain ?? createDeterministicBrain(), trigger: "manual", probeIneligible: o.probe ?? false, logger });
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** A tool session on its own (fresh bounds), for tests that call the five tools directly. */
export async function openTools(stack: Stack, o: { stdio?: boolean; fetchImpl?: typeof fetch } = {}): Promise<ToolSession> {
  const logger = createLogger((l) => stack.agentLogs.push(l));
  if (o.stdio === true) return spawnStdioServer({ env: buildToolServerEnv(agentConfig(stack), process.env), cwd: ROOT });
  const guard = createGuardClient({ baseUrl: stack.url, token: TOKEN, logger, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  return connectInProcess(createToolServer({ guard, logger }));
}

export const paymentRequests = (seen: readonly SeenRequest[]): SeenRequest[] => seen.filter((r) => r.method === "POST" && r.path === "/internal/payment-requests");

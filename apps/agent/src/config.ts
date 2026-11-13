import { inspect } from "node:util";
import { AGENT_REASON_MAX_CHARS, AgentModeSchema, type AgentMode } from "@flow-ai/contracts";
import { findForbiddenEnv, OS_ENV_NAMES } from "./env-guard";
import { validateGuardUrl } from "./guard/client";

/** Startup misconfiguration. Messages carry variable NAMES only, never values. The CLI maps this to exit code 2. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export interface AiConfig {
  provider: "anthropic";
  model: string;
  /** Non-enumerable: JSON.stringify, spread and util.inspect never show it. */
  readonly apiKey: string;
}

export interface AgentConfig {
  guardUrl: string;
  /** Non-enumerable, see above. */
  readonly token: string;
  mode: AgentMode;
  maxToolCalls: number;
  maxPayments: number;
  reasonMaxChars: number;
  runTimeoutSeconds: number;
  scheduleIntervalMinutes: number | null;
  ai: AiConfig | null;
}

/**
 * Non-fatal findings about the environment, as variable NAMES only (never values). The caller logs them.
 * AI_API_KEY is neither required nor used outside llm mode: it is ignored (not read into the config, not forwarded).
 */
export function agentConfigWarnings(env: NodeJS.ProcessEnv): string[] {
  const mode = (env.AGENT_MODE ?? "").trim() === "" ? "deterministic" : env.AGENT_MODE?.trim();
  return mode !== "llm" && (env.AI_API_KEY ?? "").trim() !== "" ? ["AI_API_KEY is set but AGENT_MODE is not llm; it is ignored and not forwarded."] : [];
}
const DEFAULT_GUARD_URL = "http://127.0.0.1:4002";

function readInt(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return def;
  if (!/^[0-9]{1,6}$/.test(raw.trim())) throw new AgentConfigError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new AgentConfigError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  return n;
}

function hide<T extends object>(target: T, key: string, value: string): T {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
  return target;
}

/**
 * Builds the agent configuration from an environment object (never reads process.env itself).
 * Order matters: variables outside the allowlist that look like secrets or database settings are refused first, so a
 * deployment that leaks a database or signer credential into the agent fails before anything else happens (13.1B, AG-6).
 * Only allowlisted names are ever read (see env-guard.ts).
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const forbidden = findForbiddenEnv(env);
  if (forbidden.length > 0) {
    throw new AgentConfigError(`The agent environment must not contain these variables (not on the agent allowlist and secret-like): ${forbidden.join(", ")}. Remove them; the agent talks to the payment guard over HTTP only.`);
  }

  const modeParsed = AgentModeSchema.safeParse((env.AGENT_MODE ?? "").trim() === "" ? "deterministic" : env.AGENT_MODE?.trim());
  if (!modeParsed.success) throw new AgentConfigError("AGENT_MODE must be 'llm' or 'deterministic'.");
  const mode = modeParsed.data;

  const rawUrl = (env.PAYMENT_GUARD_INTERNAL_URL ?? "").trim() === "" ? DEFAULT_GUARD_URL : (env.PAYMENT_GUARD_INTERNAL_URL as string).trim();
  let guardUrl: string;
  try {
    guardUrl = validateGuardUrl(rawUrl);
  } catch (err) {
    throw new AgentConfigError(`PAYMENT_GUARD_INTERNAL_URL is invalid: ${err instanceof Error ? err.message : "unknown error"}.`);
  }

  const token = env.AGENT_TO_PAYMENT_GUARD_TOKEN ?? "";
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new AgentConfigError("AGENT_TO_PAYMENT_GUARD_TOKEN is missing or malformed (32 to 256 printable characters).");

  const maxToolCalls = readInt(env, "AGENT_MAX_TOOL_CALLS", 5, 1, 5);
  const maxPayments = readInt(env, "AGENT_MAX_PAYMENTS_PER_RUN", 1, 1, 1);
  const reasonMaxChars = readInt(env, "AGENT_REASON_MAX_CHARS", AGENT_REASON_MAX_CHARS, 1, AGENT_REASON_MAX_CHARS);
  const runTimeoutSeconds = readInt(env, "AGENT_RUN_TIMEOUT_SECONDS", 60, 5, 120);
  const scheduleIntervalMinutes = (env.AGENT_SCHEDULE_INTERVAL_MINUTES ?? "").trim() === "" ? null : readInt(env, "AGENT_SCHEDULE_INTERVAL_MINUTES", 1, 1, 1440);

  let ai: AiConfig | null = null;
  if (mode === "llm") {
    if ((env.AI_PROVIDER ?? "").trim() !== "anthropic") throw new AgentConfigError("AGENT_MODE=llm requires AI_PROVIDER=anthropic.");
    const model = (env.AI_MODEL ?? "").trim();
    if (model === "" || model.startsWith("<")) throw new AgentConfigError("AGENT_MODE=llm requires AI_MODEL (the model id is not hardcoded).");
    const apiKey = (env.AI_API_KEY ?? "").trim();
    if (apiKey.length === 0) throw new AgentConfigError("AGENT_MODE=llm requires AI_API_KEY. Set it, or use AGENT_MODE=deterministic. There is no silent fallback at startup.");
    ai = hide({ provider: "anthropic" as const, model } as { provider: "anthropic"; model: string; apiKey: string }, "apiKey", apiKey);
  }

  const config = hide(
    { guardUrl, mode, maxToolCalls, maxPayments, reasonMaxChars, runTimeoutSeconds, scheduleIntervalMinutes, ai } as {
      guardUrl: string;
      token: string;
      mode: AgentMode;
      maxToolCalls: number;
      maxPayments: number;
      reasonMaxChars: number;
      runTimeoutSeconds: number;
      scheduleIntervalMinutes: number | null;
      ai: AiConfig | null;
    },
    "token",
    token,
  );
  // A stray console.log(config) or JSON.stringify(config) must never reveal a secret.
  const view = (): Record<string, unknown> => ({ ...config, token: "[REDACTED]", ai: ai === null ? null : { provider: ai.provider, model: ai.model, apiKey: "[REDACTED]" } });
  Object.defineProperty(config, "toJSON", { value: view, enumerable: false });
  Object.defineProperty(config, inspect.custom, { value: () => inspect(view(), { depth: 4 }), enumerable: false });
  return config;
}

/** OS variables a child node process needs to start. Nothing else is inherited. */
const OS_ESSENTIALS = OS_ENV_NAMES;

/** The COMPLETE environment of the MCP tool server child: guard URL, token, bounds. No AI key, no database, no seeds. */
export function buildToolServerEnv(config: AgentConfig, parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of OS_ESSENTIALS) {
    const v = parent[k];
    if (v !== undefined) env[k] = v;
  }
  env.PAYMENT_GUARD_INTERNAL_URL = config.guardUrl;
  env.AGENT_TO_PAYMENT_GUARD_TOKEN = config.token;
  env.AGENT_MAX_TOOL_CALLS = String(config.maxToolCalls);
  env.AGENT_MAX_PAYMENTS_PER_RUN = String(config.maxPayments);
  return env;
}

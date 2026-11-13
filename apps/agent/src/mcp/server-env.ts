import { findForbiddenEnv } from "../env-guard";

/** Minimal env for the MCP child: guard URL, token and bounds. No AI key, no database, no seeds. */
export function parseServerEnv(env: NodeJS.ProcessEnv): {
  guardUrl: string;
  token: string;
  maxToolCalls: number;
  maxPayments: number;
  readMs: number;
  paymentMs: number;
} {
  const forbidden = findForbiddenEnv(env);
  if (forbidden.length > 0) throw new Error(`Forbidden variables present in the tool server environment: ${forbidden.join(", ")}`);
  const guardUrl = env.PAYMENT_GUARD_INTERNAL_URL ?? "";
  const token = env.AGENT_TO_PAYMENT_GUARD_TOKEN ?? "";
  if (guardUrl === "") throw new Error("PAYMENT_GUARD_INTERNAL_URL is required");
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("AGENT_TO_PAYMENT_GUARD_TOKEN is missing or malformed");
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${String(min)} and ${String(max)}`);
    return n;
  };
  return {
    guardUrl,
    token,
    maxToolCalls: int("AGENT_MAX_TOOL_CALLS", 5, 1, 5),
    maxPayments: int("AGENT_MAX_PAYMENTS_PER_RUN", 1, 1, 1),
    readMs: int("AGENT_TOOL_READ_TIMEOUT_MS", 10_000, 500, 30_000),
    paymentMs: int("AGENT_TOOL_PAYMENT_TIMEOUT_MS", 55_000, 1_000, 60_000),
  };
}

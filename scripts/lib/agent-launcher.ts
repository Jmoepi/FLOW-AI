/**
 * Launcher for the agent process. The agent gets a CLEAN environment built from an allowlist: OS essentials, the
 * agent-only settings below and the guard bearer token. It never inherits the parent environment, so a database URL,
 * a signer seed or a service key in the shell or in the root .env cannot reach it (13.1B). Values are never printed.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT, SECRETS_DIR } from "./common";
import { baseGuardEnv } from "./guard-launcher";

/** The only settings (besides OS essentials and the token) that may be passed to the agent. */
export const AGENT_ENV_ALLOWLIST = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_API_KEY",
  "AGENT_MODE",
  "AGENT_MAX_TOOL_CALLS",
  "AGENT_MAX_PAYMENTS_PER_RUN",
  "AGENT_REASON_MAX_CHARS",
  "AGENT_RUN_TIMEOUT_SECONDS",
  "AGENT_SCHEDULE_INTERVAL_MINUTES",
  "AGENT_POLL_SECONDS",
  "AGENT_HEALTH_HOST",
  "AGENT_HEALTH_PORT",
] as const;

export const TOKEN_FILE = path.join(SECRETS_DIR, "guard-dev.env");
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Reads the dev token written by `pnpm guard:dev`. Returns null when the file is missing or malformed. */
export function readDevToken(file: string = TOKEN_FILE): string | null {
  if (!existsSync(file)) return null;
  const m = /^GUARD_DEV_TOKEN=([0-9a-f]{64})$/m.exec(readFileSync(file, "utf8"));
  return m?.[1] !== undefined && TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** Allowlisted names only, from the real environment first, then the parsed root .env (in memory, never logged). */
export function pickAgentSettings(parent: NodeJS.ProcessEnv, dotenvValues: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AGENT_ENV_ALLOWLIST) {
    const v = parent[k] ?? dotenvValues[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  // The AI key is only meaningful in llm mode. In any other mode it is dropped here, so the agent never holds it.
  if (out.AGENT_MODE !== "llm") delete out.AI_API_KEY;
  return out;
}
/** True when an AI key is configured but will not be forwarded because the agent is not in llm mode (name-only warning). */
export function aiKeyDropped(parent: NodeJS.ProcessEnv, dotenvValues: Record<string, string>): boolean {
  const key = parent.AI_API_KEY ?? dotenvValues.AI_API_KEY;
  const mode = parent.AGENT_MODE ?? dotenvValues.AGENT_MODE;
  return key !== undefined && key !== "" && mode !== "llm";
}

/** Pure: the complete child environment. */
export function buildAgentEnv(opts: { parent: NodeJS.ProcessEnv; dotenvValues: Record<string, string>; token: string; guardPort: number }): NodeJS.ProcessEnv {
  return {
    ...baseGuardEnv(opts.parent),
    ...pickAgentSettings(opts.parent, opts.dotenvValues),
    PAYMENT_GUARD_INTERNAL_URL: `http://127.0.0.1:${String(opts.guardPort)}`,
    AGENT_TO_PAYMENT_GUARD_TOKEN: opts.token,
  };
}

function readRootDotenv(): Record<string, string> {
  const file = path.join(ROOT, ".env");
  return existsSync(file) ? dotenv.parse(readFileSync(file)) : {};
}

/** Spawns the agent (no shell, argument array) and resolves with its exit code. */
export function startAgent(opts: { guardPort: number; token: string; args: readonly string[] }): Promise<number> {
  const dotenvValues = readRootDotenv();
  if (aiKeyDropped(process.env, dotenvValues)) process.stderr.write("AI_API_KEY is set but AGENT_MODE is not llm; it is not passed to the agent.\n");
  const env = buildAgentEnv({ parent: process.env, dotenvValues, token: opts.token, guardPort: opts.guardPort });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join("apps", "agent", "src", "main.ts"), ...opts.args], { cwd: ROOT, env, stdio: "inherit", shell: false });
    const forward = (sig: NodeJS.Signals) => (): void => {
      child.kill(sig);
    };
    process.once("SIGINT", forward("SIGINT"));
    process.once("SIGTERM", forward("SIGTERM"));
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

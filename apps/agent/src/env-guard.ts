/**
 * The agent process holds no database credential, no signer seed and no service key (13.1B, AG-6).
 * The environment check is an ALLOWLIST of names: only the variables below are ever read. Any other variable whose
 * name looks like a secret or a connection string fails startup, so a credential leaked into the agent is caught even
 * when its name is one we never thought of. Other unknown variables are ignored and never forwarded (the tool server
 * child gets an explicit minimal environment, see buildToolServerEnv). Names only; values are never read or printed.
 */
/** Settings the agent process reads. */
export const AGENT_SETTING_NAMES = [
  "AGENT_TO_PAYMENT_GUARD_TOKEN",
  "PAYMENT_GUARD_INTERNAL_URL",
  "AGENT_MODE",
  "AGENT_MAX_TOOL_CALLS",
  "AGENT_MAX_PAYMENTS_PER_RUN",
  "AGENT_REASON_MAX_CHARS",
  "AGENT_RUN_TIMEOUT_SECONDS",
  "AGENT_SCHEDULE_INTERVAL_MINUTES",
  "AGENT_POLL_SECONDS",
  "AGENT_HEALTH_HOST",
  "AGENT_HEALTH_PORT",
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_API_KEY",
] as const;
/** OS variables a node process needs. Never secret, never forwarded except to the tool server child (see server env). */
export const OS_ENV_NAMES = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "OS", "LANG",
] as const;
const ALLOWED: ReadonlySet<string> = new Set<string>([...AGENT_SETTING_NAMES, ...OS_ENV_NAMES]);
/** Always refused (named in the docs), even if a pattern change ever missed them. */
const FORBIDDEN_EXACT = new Set(["DATABASE_URL", "GUARD_DATABASE_URL", "OWNER_TREASURY_MASTER_SEED", "PAYMENT_EXECUTION_ENABLED", "DEMO_OWNER_PASSWORD", "WEB_DATABASE_URL"]);
/** Names that look like a secret, a credential or a database/connection setting. */
const SECRETISH: readonly RegExp[] = [
  /SEED/i, /SECRET/i, /PASSWORD/i, /PASSWD/i, /PRIVATE/i, /MNEMONIC/i, /CREDENTIAL/i, /SERVICE_ROLE/i, /^SUPABASE_/i, /JWT/i, /DSN/i,
  /(^|_)(API_?KEY|ACCESS_?KEY|AUTH_?KEY|KEY)$/i, /(^|_)TOKEN(_|$)/i, /DATABASE/i, /POSTGRES/i, /^PG[A-Z]*$/, /(^|_)DB_/i, /_DB$/i,
  /(^|_)(MASTER|SIGNER|WALLET|REGULAR_KEY)(_|$)/i,
];
export function isForbiddenEnvName(name: string): boolean {
  if (ALLOWED.has(name)) return false;
  return FORBIDDEN_EXACT.has(name) || SECRETISH.some((re) => re.test(name));
}
/** Names (sorted) of variables outside the allowlist that are forbidden or look secret, set to anything (even empty). */
export function findForbiddenEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && isForbiddenEnvName(k))
    .sort();
}

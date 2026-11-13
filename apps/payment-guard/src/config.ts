import { z } from "zod";
import { assertTestnetAsset, assertTestnetConfig } from "@flow-ai/xrpl-adapter";
/** Thrown for any invalid setting. Carries variable NAMES only, never values (they may be secrets). */
export class ConfigError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`Invalid payment guard configuration: ${fields.join(", ")}`);
    this.name = "ConfigError";
    this.fields = fields;
  }
}
export interface GuardConfig {
  network: string;
  wsUrl: string;
  rlusd: { currencyHex: string; issuer: string; displaySymbol: string };
  databaseUrl: string;
  /** [current, next?] bearer tokens for the agent (SV-2 rotation). */
  tokens: readonly string[];
  host: string;
  port: number;
  businessId: string | undefined;
  staleReservationTimeoutSeconds: number;
  /** A `running` agent run with no activity for this long is marked interrupted by the sweeper. */
  agentRunStaleSeconds: number;
  balancePollIntervalSeconds: number;
  reconcileIntervalSeconds: number;
  /** How often the audit hash chain is re-verified (AL-3). */
  auditVerifyIntervalSeconds: number;
  rateLimitPerMinute: number;
  /** How long the HTTP request waits for a validated outcome before answering 202 pending_confirmation. */
  paymentWaitSeconds: number;
}
const int = (min: number, max: number, def: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((v) => v ?? def);
/** Longest wait for a payment answer without a run event (the agent's payment tool timeout), in seconds. */
export const AGENT_PAYMENT_WAIT_SECONDS = 55;
export const AGENT_RUN_STALE_MIN_SECONDS = 120;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const token = z.string().min(32).max(256).regex(/^[\x21-\x7e]+$/);
const EnvSchema = z.object({
  XRPL_NETWORK: z.string().min(1),
  XRPL_WS_URL: z.string().min(1),
  RLUSD_ISSUER: z.string().min(1),
  RLUSD_CURRENCY_HEX: z.string().min(1),
  RLUSD_DISPLAY_SYMBOL: z.string().regex(/^[A-Za-z0-9]{1,20}$/).optional(),
  GUARD_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//).max(2048),
  AGENT_TO_PAYMENT_GUARD_TOKEN: token,
  AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT: token.optional(),
  GUARD_HOST: z.string().min(1).max(253).optional(),
  GUARD_PORT: int(1, 65535, 4002),
  GUARD_BUSINESS_ID: z.uuid().optional(),
  STALE_RESERVATION_TIMEOUT_SECONDS: int(30, 3600, 300),
  // Floor: a payment request can wait up to 55 s (agent tool timeout) without any run activity, so the stale threshold must
  // be well above it or a healthy run could be marked interrupted mid-payment. 120 s = 55 s + a generous margin.
  AGENT_RUN_STALE_SECONDS: int(AGENT_RUN_STALE_MIN_SECONDS, 3600, 180),
  BALANCE_POLL_INTERVAL_SECONDS: int(5, 600, 30),
  RECONCILE_INTERVAL_SECONDS: int(5, 600, 15),
  AUDIT_VERIFY_INTERVAL_SECONDS: int(10, 86400, 300),
  GUARD_RATE_LIMIT_PER_MINUTE: int(1, 1000, 30),
  GUARD_PAYMENT_WAIT_SECONDS: int(5, 300, 45),
});
/**
 * Fail closed (G-1, 10.1): anything missing, malformed or not Testnet throws ConfigError. PAYMENT_EXECUTION_ENABLED is
 * deliberately NOT parsed here: the raw string is re-read from the environment at request time (13.1C). The signer seed
 * is never read by this module.
 */
export function loadConfig(env: NodeJS.ProcessEnv): GuardConfig {
  const bad = new Set<string>();
  // Empty strings count as unset so `KEY=` lines in a .env file do not slip past optional-field handling.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v !== "") cleaned[k] = v;
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) for (const issue of parsed.error.issues) bad.add(String(issue.path[0] ?? "ENV"));
  try {
    assertTestnetConfig(cleaned.XRPL_NETWORK, cleaned.XRPL_WS_URL);
  } catch {
    bad.add("XRPL_NETWORK");
    bad.add("XRPL_WS_URL");
  }
  try {
    assertTestnetAsset(cleaned.RLUSD_ISSUER, cleaned.RLUSD_CURRENCY_HEX);
  } catch {
    bad.add("RLUSD_ISSUER");
    bad.add("RLUSD_CURRENCY_HEX");
  }
  if (cleaned.AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT !== undefined && cleaned.AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT === cleaned.AGENT_TO_PAYMENT_GUARD_TOKEN) {
    bad.add("AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT");
  }
  // The tenant pin is the only business boundary (RLS is USING (true) for the guard role), so it is mandatory outside
  // local development: NODE_ENV=production, or a bind address that is not loopback (a deployment).
  const nonLocal = cleaned.NODE_ENV === "production" || (cleaned.GUARD_HOST !== undefined && !LOOPBACK_HOSTS.has(cleaned.GUARD_HOST.toLowerCase()));
  if (nonLocal && cleaned.GUARD_BUSINESS_ID === undefined) bad.add("GUARD_BUSINESS_ID");
  if (!parsed.success || bad.size > 0) throw new ConfigError([...bad].sort());
  const e = parsed.data;
  return {
    network: e.XRPL_NETWORK,
    wsUrl: e.XRPL_WS_URL,
    rlusd: { currencyHex: e.RLUSD_CURRENCY_HEX, issuer: e.RLUSD_ISSUER, displaySymbol: e.RLUSD_DISPLAY_SYMBOL ?? "RLUSD" },
    databaseUrl: e.GUARD_DATABASE_URL,
    tokens: e.AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT === undefined ? [e.AGENT_TO_PAYMENT_GUARD_TOKEN] : [e.AGENT_TO_PAYMENT_GUARD_TOKEN, e.AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT],
    host: e.GUARD_HOST ?? "127.0.0.1",
    port: e.GUARD_PORT,
    businessId: e.GUARD_BUSINESS_ID?.toLowerCase(),
    staleReservationTimeoutSeconds: e.STALE_RESERVATION_TIMEOUT_SECONDS,
    agentRunStaleSeconds: e.AGENT_RUN_STALE_SECONDS,
    balancePollIntervalSeconds: e.BALANCE_POLL_INTERVAL_SECONDS,
    reconcileIntervalSeconds: e.RECONCILE_INTERVAL_SECONDS,
    auditVerifyIntervalSeconds: e.AUDIT_VERIFY_INTERVAL_SECONDS,
    rateLimitPerMinute: e.GUARD_RATE_LIMIT_PER_MINUTE,
    paymentWaitSeconds: e.GUARD_PAYMENT_WAIT_SECONDS,
  };
}
/** Startup check on the database role (13.1B): a superuser or BYPASSRLS role defeats row level security. */
export function assertLeastPrivilegeRole(flags: { rolsuper: boolean; rolbypassrls: boolean }): void {
  if (flags.rolsuper || flags.rolbypassrls) {
    throw new Error("Refusing to start: the guard database role must not be a superuser or have BYPASSRLS.");
  }
}

import { z } from "zod";
/** Thrown for any invalid setting. Carries variable NAMES only, never values (they may be secrets). */
export class WebConfigError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`Invalid web configuration: ${fields.join(", ")}`);
    this.name = "WebConfigError";
    this.fields = fields;
  }
}
export interface WebConfig {
  databaseUrl: string;
  /** Exact origin of the app, e.g. http://127.0.0.1:3000 (used for the Origin check and the cookie flags). */
  appOrigin: string;
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  /** Seconds after which an owner write needs a fresh login (AU-6). */
  stepUpSeconds: number;
  cookieSecure: boolean;
  /**
   * Number of trusted reverse proxies in front of the app (0 to 5). The client IP is the X-Forwarded-For entry that many
   * places from the right, so a spoofed leftmost entry never picks the rate-limit bucket. 0 means no proxy is trusted.
   */
  trustedProxyHops: number;
  rlusd: { currencyHex: string; issuer: string };
}
/** Same value as the xrpl-adapter constant (a web test pins them together). The web app must never use the Mainnet issuer. */
export const MAINNET_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
/**
 * Secrets that belong to the payment guard, the agent or an admin. The web process must not even receive them
 * (SV-5, 13.1B): their presence is a configuration error, not something to ignore.
 */
const FORBIDDEN_EXACT = new Set([
  "OWNER_TREASURY_MASTER_SEED",
  "AGENT_TO_PAYMENT_GUARD_TOKEN",
  "AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GUARD_DATABASE_URL",
  "DATABASE_URL",
  "AI_API_KEY",
]);
const FORBIDDEN_PATTERN = /^XRPL_[A-Z0-9_]*SEED$/;
export function forbiddenEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => (FORBIDDEN_EXACT.has(k) || FORBIDDEN_PATTERN.test(k)) && env[k] !== undefined && env[k] !== "")
    .sort();
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const intIn = (min: number, max: number, def: number) =>
  z
    .string()
    .regex(/^\d{1,7}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((v) => v ?? def);
const EnvSchema = z.object({
  WEB_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//).max(2048),
  APP_BASE_URL: z.string().min(8).max(200),
  SESSION_IDLE_SECONDS: intIn(60, 86_400, 1800),
  SESSION_ABSOLUTE_SECONDS: intIn(300, 604_800, 28_800),
  STEP_UP_SECONDS: intIn(60, 3600, 900),
  WEB_TRUST_PROXY: z.enum(["true", "false"]).optional(),
  WEB_TRUSTED_PROXY_HOPS: z
    .string()
    .regex(/^[0-5]$/)
    .transform(Number)
    .optional(),
  RLUSD_ISSUER: z.string().regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/),
  RLUSD_CURRENCY_HEX: z.string().regex(/^[0-9A-F]{40}$/),
});
/** Fail closed: anything missing, malformed, forbidden or non-Testnet throws WebConfigError (names only). */
export function loadWebConfig(env: NodeJS.ProcessEnv): WebConfig {
  const bad = new Set<string>(forbiddenEnvNames(env));
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v !== "") cleaned[k] = v;
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) for (const issue of parsed.error.issues) bad.add(String(issue.path[0] ?? "ENV"));
  let origin = "";
  let secure = false;
  if (parsed.success) {
    try {
      const url = new URL(parsed.data.APP_BASE_URL);
      const loopback = LOOPBACK.has(url.hostname);
      const isHttps = url.protocol === "https:";
      if ((url.protocol !== "http:" && !isHttps) || (!isHttps && !loopback) || url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
        bad.add("APP_BASE_URL");
      }
      if (cleaned.NODE_ENV === "production" && !isHttps) bad.add("APP_BASE_URL");
      origin = url.origin;
      secure = isHttps;
    } catch {
      bad.add("APP_BASE_URL");
    }
    if (parsed.data.RLUSD_ISSUER === MAINNET_RLUSD_ISSUER) bad.add("RLUSD_ISSUER");
    if (parsed.data.SESSION_IDLE_SECONDS > parsed.data.SESSION_ABSOLUTE_SECONDS) bad.add("SESSION_IDLE_SECONDS");
    // WEB_TRUST_PROXY=true is the legacy alias for one hop; stating both with different meanings is a configuration error.
    const alias = parsed.data.WEB_TRUST_PROXY === undefined ? undefined : parsed.data.WEB_TRUST_PROXY === "true" ? 1 : 0;
    if (alias !== undefined && parsed.data.WEB_TRUSTED_PROXY_HOPS !== undefined && alias !== parsed.data.WEB_TRUSTED_PROXY_HOPS) bad.add("WEB_TRUSTED_PROXY_HOPS");
  }
  if (!parsed.success || bad.size > 0) throw new WebConfigError([...bad].sort());
  const e = parsed.data;
  return {
    databaseUrl: e.WEB_DATABASE_URL,
    appOrigin: origin,
    sessionIdleSeconds: e.SESSION_IDLE_SECONDS,
    sessionAbsoluteSeconds: e.SESSION_ABSOLUTE_SECONDS,
    stepUpSeconds: e.STEP_UP_SECONDS,
    cookieSecure: secure,
    trustedProxyHops: e.WEB_TRUSTED_PROXY_HOPS ?? (e.WEB_TRUST_PROXY === "true" ? 1 : 0),
    rlusd: { currencyHex: e.RLUSD_CURRENCY_HEX, issuer: e.RLUSD_ISSUER },
  };
}
/** Startup check on the database role (13.1B): a superuser or BYPASSRLS role defeats row level security. */
export function assertLeastPrivilegeRole(flags: { rolsuper: boolean; rolbypassrls: boolean }): void {
  if (flags.rolsuper || flags.rolbypassrls) {
    throw new Error("Refusing to start: the web database role must not be a superuser or have BYPASSRLS.");
  }
}

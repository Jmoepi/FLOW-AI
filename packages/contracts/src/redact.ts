/**
 * Central secret redaction (spec 13.1 "Sanitize logs and user-facing errors", 10.4).
 *
 * Every log line, thrown message, JSON log and user-facing error that could carry data from a signer,
 * a ledger response or a provider must pass through `redactString`, `redactValue`, `redactError` or
 * `safeStringify`. The same rule table drives `pnpm secret-scan`, so the scanner and the redactor agree.
 *
 * All patterns are linear-time (single bounded quantifiers, no nested repetition) so hostile input
 * cannot cause catastrophic backtracking.
 */

export const REDACTED = "[REDACTED]";

export interface SecretRule {
  rule: string;
  /** Non-global pattern (safe for `.test`). */
  pattern: RegExp;
  /** Optional extra check used by the scanner to cut false positives. Redaction ignores it (over-redact). */
  scanAccept?: (match: string) => boolean;
}

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])";

export const SECRET_RULES: readonly SecretRule[] = [
  {
    // XRPL family seeds: secp256k1 "s..." and ed25519 "sEd..." (29 chars in practice; 24..34 tolerated).
    rule: "xrpl-family-seed-pattern",
    pattern: new RegExp(`${NOT_ALNUM_BEFORE}s${B58}{24,34}${NOT_ALNUM_AFTER}`),
    // Real seeds are mixed-case/digit base58; skip plain lowercase words when scanning.
    scanAccept: (m) => /[0-9A-Z]/.test(m.slice(1)),
  },
  {
    // 66 hex chars starting with ED or 00: a prefixed private key (an ed25519 public key has the same shape).
    rule: "hex-private-key-pattern",
    pattern: /(?<![0-9A-Fa-f])(?:ED|00)[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/,
  },
  {
    // Key-labelled 64-hex value, e.g. privateKey: "<64 hex>" or SECRET_KEY=<64 hex>.
    rule: "labelled-hex-secret",
    pattern: /(?:private[_-]?key|secret[_-]?key|priv[_-]?key)["']?\s{0,4}[:=]\s{0,4}["']?[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/i,
  },
  {
    // Signed transaction blobs are long hex strings (a minimal Payment blob is several hundred hex chars).
    rule: "signed-tx-blob-pattern",
    pattern: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{160,}(?![0-9A-Fa-f])/,
  },
  { rule: "anthropic-api-key", pattern: new RegExp(`${NOT_ALNUM_BEFORE}sk-ant-[A-Za-z0-9_-]{20,}`) },
  { rule: "openai-style-api-key", pattern: new RegExp(`${NOT_ALNUM_BEFORE}sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}`) },
  { rule: "github-token", pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/ },
  { rule: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "bearer-token", pattern: /(?<![A-Za-z0-9])Bearer\s{1,4}[A-Za-z0-9._~+/=-]{20,}/i },
  // Header only; the body is removed by the dedicated PEM step in redactString.
  { rule: "pem-private-key-block", pattern: /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----/ },
];

/** Env var names whose values are secrets (also used by the scanner for `NAME=value` assignments). */
export const SECRET_ENV_NAMES: readonly string[] = [
  "XRPL_DEMO_SIGNER_SEED",
  "XRPL_REGULAR_KEY_SEED",
  "OWNER_TREASURY_MASTER_SEED",
  "AI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "AGENT_TO_PAYMENT_GUARD_TOKEN",
  "DATABASE_URL",
  "GUARD_DATABASE_URL",
];

const PEM_BLOCK = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g;
// eslint-disable-next-line security/detect-non-literal-regexp -- built from constant rule tables, never from input
const ENV_ASSIGNMENT = new RegExp(`\\b(${SECRET_ENV_NAMES.join("|")})(\\s{0,4}[=:]\\s{0,4})("[^"\\r\\n]{0,512}"|'[^'\\r\\n]{0,512}'|[^\\s"',;]{1,512})`, "g");
const LABELLED_SECRET = /\b(seed|secret|passphrase|password|api[_-]?key|private[_-]?key|token)(["']?\s{0,4}[=:]\s{0,4}["']?)[^\s"',;}{]{4,512}/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]{1,128}:[^\s/@]{1,256}@/gi;

const GLOBAL_RULES: ReadonlyArray<RegExp> = SECRET_RULES.filter((r) => r.rule !== "pem-private-key-block").map(
  // eslint-disable-next-line security/detect-non-literal-regexp -- derived from the constant rule table
  (r) => new RegExp(r.pattern.source, r.pattern.flags.includes("g") ? r.pattern.flags : `${r.pattern.flags}g`),
);

/** Replaces anything secret-shaped in a string. Idempotent. */
export function redactString(text: string): string {
  let out = text.replace(PEM_BLOCK, REDACTED);
  out = out.replace(ENV_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(URL_USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = out.replace(LABELLED_SECRET, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`);
  for (const re of GLOBAL_RULES) out = out.replace(re, REDACTED);
  return out;
}

/** Object keys whose values are always replaced, whatever they contain. */
const SENSITIVE_KEY =
  /(seed|secret|passphrase|password|mnemonic|private[_-]?key|api[_-]?key|authorization|cookie|token|credential|tx[_-]?blob|signed[_-]?(?:tx|transaction)|signature|^blob$)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export interface RedactOptions {
  /** Include error stacks (redacted). Default false: stacks can embed argument values. */
  includeStack?: boolean;
  maxDepth?: number;
}

const MAX_DEPTH = 8;
const MAX_KEYS = 200;
const MAX_STRING = 20_000;

/** Deep copy with secrets removed. Handles cycles, Errors, arrays; never returns the original objects. */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? MAX_DEPTH;

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactString(v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...[truncated]` : v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return `[${typeof v}]`;
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    if (depth >= maxDepth) return "[MaxDepth]";
    seen.add(v);
    if (v instanceof Error) {
      const out: Record<string, unknown> = { name: v.name, message: redactString(v.message) };
      if (options.includeStack && v.stack) out.stack = redactString(v.stack);
      if ("cause" in v && v.cause !== undefined) out.cause = walk(v.cause, depth + 1);
      return out;
    }
    if (Array.isArray(v)) return v.slice(0, MAX_KEYS).map((x) => walk(x, depth + 1));
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "[InvalidDate]" : v.toISOString();
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(v).slice(0, MAX_KEYS)) {
      if (key === "__proto__") continue; // never copy a prototype-pollution vector
      const child = (v as Record<string, unknown>)[key];
      out[key] = isSensitiveKey(key) && child !== null && child !== undefined && child !== "" ? REDACTED : walk(child, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

/** JSON.stringify of the redacted copy. Never throws (cycles, bigint, getters). */
export function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(redactValue(value), null, space) ?? "undefined";
  } catch {
    return '"[unserialisable]"';
  }
}

/** One-line, redacted description of anything thrown. No stack. Use for console output and user-facing errors. */
export function redactError(err: unknown): string {
  if (err instanceof Error) return redactString(err.message);
  if (typeof err === "string") return redactString(err);
  return redactString(safeStringify(err));
}

/**
 * Starts the payment guard locally against the local Docker database (.secrets/local-db.env), Testnet only.
 * Usage: pnpm guard:dev [-- --business <uuid>] [--enable-execution] [--supabase]
 * --regular-key: sign with the revocable regular key from .secrets/guard-regular-key.env instead of the master (M7, 10.8).
 * --supabase: connect as flow_guard to the hosted Supabase database (session pooler, verified TLS; URL composed in memory
 * from .env DATABASE_URL host and .secrets/supabase-roles.env).
 * Prerequisites: pnpm db:up && pnpm db:migrate, and a seeded business. Nothing secret is printed.
 * The kill switch is OFF by default (PAYMENT_EXECUTION_ENABLED=false): no payment can execute. --enable-execution opts in.
 * The internal-API bearer token is read from the gitignored .secrets/guard-dev.env (generated there on first use, never printed).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_DB, loadLocalDbSecrets } from "../packages/database/src/index";
import { SECRETS_DIR, readPublicWallets, toErrorMessage } from "./lib/common";
import { startGuard } from "./lib/guard-launcher";
import { loadRolePasswords, loadSupabaseTarget, supabaseCaFile, supabaseUrl } from "./lib/supabase";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_FILE = path.join(SECRETS_DIR, "guard-dev.env");
const TOKEN_RE = /^[0-9a-f]{64}$/;
function parseArgs(argv: readonly string[]): { businessId?: string; enableExecution: boolean; supabase: boolean; regularKey: boolean } {
  const args = argv.filter((a) => a !== "--");
  let businessId: string | undefined;
  let enableExecution = false;
  let supabase = false;
  let regularKey = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--enable-execution") enableExecution = true;
    else if (a === "--supabase") supabase = true;
    else if (a === "--regular-key") regularKey = true;
    else if (a === "--business") {
      const v = args[++i];
      if (v === undefined || !UUID_RE.test(v)) throw new Error("Usage: guard-dev [--business <uuid>] [--enable-execution] [--supabase] [--regular-key]");
      businessId = v;
    } else throw new Error("Usage: guard-dev [--business <uuid>] [--enable-execution] [--supabase] [--regular-key]");
  }
  return { ...(businessId !== undefined ? { businessId } : {}), enableExecution, supabase, regularKey };
}
/** Reads the dev token from the gitignored file, generating it (mode 0600) when absent or malformed. Never printed. */
function loadDevToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const m = /^GUARD_DEV_TOKEN=([0-9a-f]{64})$/m.exec(readFileSync(TOKEN_FILE, "utf8"));
    if (m?.[1] !== undefined && TOKEN_RE.test(m[1])) return m[1];
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, `GUARD_DEV_TOKEN=${token}\n`, { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return token;
}
function main(): void {
  const { businessId, enableExecution, supabase, regularKey } = parseArgs(process.argv.slice(2));
  const secrets = supabase ? null : loadLocalDbSecrets(SECRETS_DIR, false);
  if (!supabase && secrets === null) throw new Error("No local database set up. Run: pnpm db:up && pnpm db:migrate");
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  if (!treasury) throw new Error("No treasury wallet in the secrets file.");
  let databaseUrl: string;
  if (supabase) {
    process.env.DATABASE_SSL_CA_FILE = supabaseCaFile(); // the launcher passes this path (not a secret) to the guard
    databaseUrl = supabaseUrl("flow_guard", loadSupabaseTarget(), loadRolePasswords());
  } else {
    databaseUrl = `postgres://flow_guard:${encodeURIComponent((secrets as NonNullable<typeof secrets>).guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${LOCAL_DB.database}`;
  }
  const guard = startGuard({
    databaseUrl,
    port: 4002,
    treasuryLabel: treasury.label,
    signerMode: regularKey ? "regular_key" : "master_env",
    executionEnabled: enableExecution,
    token: loadDevToken(),
    ...(businessId !== undefined ? { businessId } : {}),
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void guard.stop().then(() => process.exit(0)));
  guard.child.once("exit", (code) => process.exit(code ?? 1));
  console.log(`Guard starting on 127.0.0.1:4002 (Testnet, ${supabase ? "Supabase" : "local database"}). Payment execution is ${enableExecution ? "ENABLED" : "DISABLED (kill switch off)"}. The bearer token is in ${TOKEN_FILE} (not printed).`);
}
try {
  main();
} catch (err) {
  console.error(`guard-dev failed: ${toErrorMessage(err)}`);
  process.exit(1);
}

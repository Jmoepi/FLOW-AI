/**
 * Dev-only: sets a NEW random password for the demo owner login in the targeted database.
 * Usage: pnpm db:reset-owner-password -- --local
 *        pnpm db:reset-owner-password -- --supabase --allow-remote   (hosted database from DATABASE_URL; verified TLS)
 *
 * - The new password is written ONLY to the gitignored .secrets/web-owner.env (or .secrets/web-owner.supabase.env for
 *   --supabase). Only the file path is printed, never the password.
 * - Also clears the owner's account lock/failure counter, revokes the owner's sessions and deletes the login_attempts
 *   rows (the per-email and per-IP rate-limit counters are keyed by hash, so every counter is cleared in local mode).
 * - --local refuses any non-loopback host. Remote needs the explicit --allow-remote flag.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LOCAL_DB,
  assertMigrationTarget,
  clearLoginAttempts,
  createPool,
  findCredentialByEmail,
  loadLocalDbSecrets,
  localAdminConfig,
  resetLoginFailures,
  revokeAllSessionsForUser,
  updatePasswordHash,
} from "../packages/database/src/index";
import { hashPassword } from "../apps/web/src/server/auth/password";
import { SECRETS_DIR, toErrorMessage } from "./lib/common";
import { assertLocalHost, parseEnvFile, parseResetArgs } from "./lib/owner-password";
import { loadSupabaseTarget } from "./lib/supabase";

const DEFAULT_EMAIL = "owner@demo.flow-ai.test";

async function main(): Promise<void> {
  const target = parseResetArgs(process.argv.slice(2));
  const file = path.join(SECRETS_DIR, target.file);
  const existing = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : new Map<string, string>();
  const email = (process.env.DEMO_OWNER_EMAIL || existing.get("DEMO_OWNER_EMAIL") || DEFAULT_EMAIL).trim().toLowerCase();

  let pool: ReturnType<typeof createPool>;
  if (target.supabase) {
    const t = loadSupabaseTarget();
    const url = process.env.DATABASE_URL as string;
    assertMigrationTarget(url, true, true);
    pool = createPool({ connectionString: url, sslCaFile: t.caFile, max: 2, applicationName: "flow-ai-reset-owner" });
  } else {
    const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
    if (secrets === null) throw new Error("No local database set up. Run: pnpm db:up && pnpm db:migrate");
    const c = localAdminConfig(secrets);
    assertLocalHost(c.host ?? "");
    if (c.host !== LOCAL_DB.host) throw new Error("Refusing: not the loopback database.");
    pool = createPool({ config: { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database }, max: 2, applicationName: "flow-ai-reset-owner" });
  }
  try {
    const cred = await findCredentialByEmail(pool, email);
    if (cred === null) throw new Error("The demo owner does not exist in this database. Run: pnpm db:seed:demo" + (target.supabase ? " -- --supabase" : ""));
    const password = randomBytes(24).toString("base64url");
    await updatePasswordHash(pool, cred.user_id, await hashPassword(password));
    await resetLoginFailures(pool, cred.user_id);
    const sessions = await revokeAllSessionsForUser(pool, cred.user_id, new Date());
    // login_attempts is keyed by one-way hashes (email and IP buckets): clear them all in this dev database.
    const attempts = await clearLoginAttempts(pool);
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, `DEMO_OWNER_EMAIL=${email}\nDEMO_OWNER_PASSWORD=${password}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on Windows */
    }
    console.log(`Owner password reset (${target.supabase ? "Supabase" : "local"} database). Sessions revoked: ${String(sessions)}; login attempt rows cleared: ${String(attempts)}.`);
    console.log(`New credentials written to ${file} (gitignored, not printed). Email: ${email}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`db:reset-owner-password failed: ${toErrorMessage(err)}`);
  process.exitCode = 1;
});

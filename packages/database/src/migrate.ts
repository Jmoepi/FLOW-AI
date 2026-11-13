import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redactError } from "@flow-ai/contracts";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary constant: serialises concurrent migration runners on the same database. */
const MIGRATION_LOCK_KEY = 7_412_903_551;

/** Configuration problem. Messages are fixed strings: they never contain the connection string or password. */
export class MigrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationConfigError";
  }
}

/**
 * Checksums of earlier revisions of a migration that are accepted as "already applied". 0001 and 0006 originally named
 * NOSUPERUSER in an ALTER ROLE, which hosted Postgres (Supabase, non-superuser admin) rejects; the new text is equivalent
 * on a superuser database, so databases migrated with the old text stay valid and nothing is re-run.
 */
const SUPERSEDED_CHECKSUMS: Readonly<Record<string, readonly string[]>> = {
  "0001": ["b473eb6b9d1c54141cf8d34106d8d2ca7287634c557cc04ff5cfbc77fe6313c4"],
  "0006": ["0e08be4b26b3db4227201de4098319e181da2ddda272fda3cb1d0195006c7640"],
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SECURE_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Refuses to migrate anything but a local database unless `allowRemote` is set. A remote target must additionally use
 * TLS (sslmode require, verify-ca or verify-full, or a verified CA file). Errors never echo the URL (it carries the password).
 */
export function assertMigrationTarget(databaseUrl: string | undefined, allowRemote: boolean, hasVerifiedCa = false): void {
  if (databaseUrl === undefined || databaseUrl === "") throw new MigrationConfigError("DATABASE_URL is not set");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new MigrationConfigError("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new MigrationConfigError("DATABASE_URL must use the postgres:// scheme");
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;
  if (!allowRemote) {
    throw new MigrationConfigError("Refusing to migrate a non-local database. Re-run with --allow-remote if this is intended.");
  }
  if (hasVerifiedCa) return; // DATABASE_SSL_CA_FILE: the connection is built with verified TLS regardless of sslmode
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === null || !SECURE_SSLMODES.has(sslmode)) {
    throw new MigrationConfigError("A remote database requires sslmode=require, verify-ca or verify-full in DATABASE_URL.");
  }
}

export interface MigrateArgs {
  command: "up" | "status";
  allowRemote: boolean;
  /** Force the local Docker database even when DATABASE_URL is set. */
  local: boolean;
}

/** Strict parser: unknown flags and stray arguments are errors. A leading "--" (pnpm passthrough) is ignored. */
export function parseMigrateArgs(argv: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { command: "up", allowRemote: false, local: false };
  let commandSeen = false;
  argv.forEach((arg, i) => {
    if (arg === "--" && i === 0) return;
    if (arg === "--allow-remote") out.allowRemote = true;
    else if (arg === "--local") out.local = true;
    else if ((arg === "up" || arg === "status") && !commandSeen) {
      out.command = arg;
      commandSeen = true;
    } else throw new MigrationConfigError("Usage: db:migrate [up|status] [--local] [--allow-remote]");
  });
  if (out.local && out.allowRemote) throw new MigrationConfigError("--local and --allow-remote cannot be combined");
  return out;
}

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

/** Checksum is over LF-normalised text so a CRLF checkout does not look like a changed migration. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  return names.map((name) => {
    const sql = readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n");
    const m = FILE_RE.exec(name);
    return { version: m?.[1] ?? name, name, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
  });
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
  pending: string[];
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  name       text NOT NULL,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON schema_migrations FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'schema_migrations' AND policyname = 'migrator_all') THEN
    CREATE POLICY migrator_all ON schema_migrations FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
  END IF;
END
$$;`;

export interface MigrateOptions {
  dir?: string;
  /** "status" never changes the schema (it still reads schema_migrations if present). */
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Applies pending migrations in order, one transaction per file, under an advisory lock. Refuses to continue if an
 * already-applied file's checksum changed. Re-running with nothing pending is a no-op.
 * `client` must be a dedicated, connected pg.Client (admin/owner role).
 */
export async function migrate(client: pg.Client, options: MigrateOptions = {}): Promise<MigrationReport> {
  const log = options.log ?? (() => undefined);
  const files = loadMigrations(options.dir);
  const report: MigrationReport = { applied: [], skipped: [], pending: [] };
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    let appliedMap = new Map<string, string>();
    if (options.dryRun) {
      const exists = await client.query<{ ok: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok");
      if (exists.rows[0]?.ok === true) {
        const rows = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
        appliedMap = new Map(rows.rows.map((r) => [r.version, r.checksum]));
      }
    } else {
      await client.query(BOOTSTRAP_SQL);
      const rows = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
      appliedMap = new Map(rows.rows.map((r) => [r.version, r.checksum]));
    }
    for (const f of files) {
      const existing = appliedMap.get(f.version);
      if (existing !== undefined) {
        if (existing !== f.checksum && !(SUPERSEDED_CHECKSUMS[f.version]?.includes(existing) ?? false)) throw new MigrationConfigError(`Migration ${f.name} was changed after it was applied. Add a new migration instead.`);
        report.skipped.push(f.name);
        continue;
      }
      if (options.dryRun) {
        report.pending.push(f.name);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(f.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [f.version, f.name, f.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${f.name} failed: ${redactError(err)}`, { cause: err });
      }
      report.applied.push(f.name);
      log(`applied ${f.name}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
  }
  return report;
}

/** Connects with the given config, runs migrate(), always disconnects. The config (and its password) is never logged. */
export async function runMigrations(config: pg.ClientConfig, options: MigrateOptions = {}): Promise<MigrationReport> {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await migrate(client, options);
  } finally {
    await client.end();
  }
}

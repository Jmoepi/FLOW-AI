import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LOCAL_DB, ensureGuardRole, loadLocalDbSecrets, localAdminConfig, localGuardConfig, type LocalDbSecrets } from "../local";
import { migrate } from "../migrate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const SECRETS_DIR = path.join(ROOT, ".secrets");
export const NOT_REACHABLE_MESSAGE = `Postgres not reachable at ${LOCAL_DB.host}:${String(LOCAL_DB.port)}. Start Docker Desktop, then run: pnpm db:up`;

export interface TestDatabase {
  /** Superuser pool on the throwaway database (bypasses RLS). Tests use it for setup and tamper checks only. */
  adminPool: pg.Pool;
  /** The real least-privilege flow_guard role. */
  guardPool: pg.Pool;
  /** A login role that was granted nothing. */
  noGrantPool: pg.Pool;
  name: string;
  secrets: LocalDbSecrets;
  drop: () => Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** SQL run on the new (empty) database BEFORE migrations, e.g. to simulate Supabase default privileges. */
  beforeMigrate?: (admin: pg.Pool) => Promise<void>;
}

/** Creates `flow_test_<random>`, migrates it, wires the guard and no-grant roles. Call drop() when done. */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error(NOT_REACHABLE_MESSAGE);
  const name = `flow_test_${randomBytes(6).toString("hex")}`;
  const maint = new pg.Client({ ...localAdminConfig(secrets, "postgres"), connectionTimeoutMillis: 3000 });
  try {
    await maint.connect();
  } catch {
    throw new Error(NOT_REACHABLE_MESSAGE);
  }
  try {
    await maint.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
    await ensureGuardRole(maint, secrets.guardPassword);
  } finally {
    await maint.end();
  }
  const adminPool = new pg.Pool({ ...localAdminConfig(secrets, name), max: 4 });
  adminPool.on("error", () => undefined);
  if (options.beforeMigrate) await options.beforeMigrate(adminPool);
  const mig = new pg.Client(localAdminConfig(secrets, name));
  await mig.connect();
  try {
    await migrate(mig);
  } finally {
    await mig.end();
  }
  // flow_nogrant: login role with no privileges at all (cluster-level; created idempotently, password rotated per run).
  const noGrantPassword = randomBytes(16).toString("hex");
  const admin = await adminPool.connect();
  try {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_nogrant') THEN CREATE ROLE flow_nogrant LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
    await admin.query("SELECT set_config('flow.pw', $1, false)", [noGrantPassword]);
    await admin.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE flow_nogrant PASSWORD %L', current_setting('flow.pw')); END $$`);
    await admin.query("RESET flow.pw");
  } finally {
    admin.release();
  }
  const guardPool = new pg.Pool({ ...localGuardConfig(secrets, name), max: 8 });
  const noGrantPool = new pg.Pool({ host: LOCAL_DB.host, port: LOCAL_DB.port, user: "flow_nogrant", password: noGrantPassword, database: name, max: 2 });
  guardPool.on("error", () => undefined);
  noGrantPool.on("error", () => undefined);
  return {
    adminPool,
    guardPool,
    noGrantPool,
    name,
    secrets,
    drop: async () => {
      await Promise.all([guardPool.end(), noGrantPool.end(), adminPool.end()]).catch(() => undefined);
      const c = new pg.Client(localAdminConfig(secrets, "postgres"));
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
export * from "./scenario";

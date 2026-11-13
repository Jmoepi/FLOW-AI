import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LOCAL_DB, ensureGuardRole, ensureRole, loadLocalDbSecrets, localAdminConfig, localGuardConfig, localWebConfig, type LocalDbSecrets } from "../local";
import { migrate } from "../migrate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const SECRETS_DIR = path.join(ROOT, ".secrets");
export const NOT_REACHABLE_MESSAGE =
  process.env.FLOW_TEST_DB === "native"
    ? `Postgres not reachable at ${LOCAL_DB.host}:${String(LOCAL_DB.port)}. Start the Docker-free database with: pnpm db:up:native`
    : `Postgres not reachable at ${LOCAL_DB.host}:${String(LOCAL_DB.port)}. Start Docker Desktop, then run: pnpm db:up (or, without Docker: pnpm db:up:native)`;

/** Set by the vitest globalSetup; every throwaway database created in that run is tagged with it so teardown can drop them. */
export const TEST_RUN_ENV = "FLOW_TEST_RUN_ID";
const TEST_DB_NAME = /^flow_test_[0-9a-f]{12}$/;
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const runTag = (runId: string): string => `flow-test-run:${runId}`;
/**
 * Drops the throwaway databases that were created (and tagged) by ONE test run. Only databases whose name is exactly
 * `flow_test_<12 hex>` AND whose comment carries this run's tag are touched; the dev database, `postgres` and anything
 * else are never selected. Returns the dropped names. Safe to call when nothing was created.
 */
export async function dropTestDatabasesForRun(secrets: LocalDbSecrets, runId: string): Promise<string[]> {
  if (!RUN_ID.test(runId)) throw new Error("invalid test run id");
  const c = new pg.Client({ ...localAdminConfig(secrets, "postgres"), connectionTimeoutMillis: 3000 });
  await c.connect();
  const dropped: string[] = [];
  try {
    const found = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'flow\\_test\\_%' AND shobj_description(oid, 'pg_database') = $1",
      [runTag(runId)],
    );
    for (const { datname } of found.rows) {
      if (!TEST_DB_NAME.test(datname)) continue;
      await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`);
      dropped.push(datname);
    }
  } finally {
    await c.end();
  }
  return dropped;
}
export interface TestDatabase {
  /** Superuser pool on the throwaway database (bypasses RLS). Tests use it for setup and tamper checks only. */
  adminPool: pg.Pool;
  /** The real least-privilege flow_guard role. */
  guardPool: pg.Pool;
  /** The real least-privilege flow_web role (owner web app). */
  webPool: pg.Pool;
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

/** Arbitrary constant: serialises role and migration DDL of parallel test suites (see createTestDatabase). */
const ROLE_SETUP_LOCK = 7_412_903_552;
/**
 * Creates `flow_test_<random>`, migrates it, wires the guard, web and no-grant roles. Call drop() when done.
 * Role DDL (ALTER ROLE here and in the migrations) rewrites cluster-wide catalog rows, so test suites running in
 * parallel could fail with "tuple concurrently updated". One advisory lock held on a connection to the maintenance
 * database serialises the whole setup; closing that connection releases it, even after a crash.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error(NOT_REACHABLE_MESSAGE);
  const lock = new pg.Client({ ...localAdminConfig(secrets, "postgres"), connectionTimeoutMillis: 3000 });
  try {
    await lock.connect();
  } catch {
    throw new Error(NOT_REACHABLE_MESSAGE);
  }
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [ROLE_SETUP_LOCK]);
    return await createLocked(options, secrets);
  } finally {
    await lock.end().catch(() => undefined);
  }
}
async function createLocked(options: CreateTestDatabaseOptions, secrets: LocalDbSecrets): Promise<TestDatabase> {
  const name = `flow_test_${randomBytes(6).toString("hex")}`;
  const maint = new pg.Client({ ...localAdminConfig(secrets, "postgres"), connectionTimeoutMillis: 3000 });
  try {
    await maint.connect();
  } catch {
    throw new Error(NOT_REACHABLE_MESSAGE);
  }
  try {
    await maint.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
    const runId = process.env[TEST_RUN_ENV];
    if (runId !== undefined && RUN_ID.test(runId)) await maint.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(name)} IS ${pg.escapeLiteral(runTag(runId))}`);
    await ensureGuardRole(maint, secrets.guardPassword);
    await ensureRole(maint, "flow_web", secrets.webPassword);
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
  // flow_nogrant: login role with no privileges at all (cluster-level, created idempotently). Its password is derived from the local
  // admin secret, so parallel suites set the SAME value instead of invalidating each other's connections by rotating it.
  const noGrantPassword = createHmac("sha256", secrets.adminPassword).update("flow_nogrant").digest("hex").slice(0, 32);
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
  const webPool = new pg.Pool({ ...localWebConfig(secrets, name), max: 8 });
  webPool.on("error", () => undefined);
  const noGrantPool = new pg.Pool({ host: LOCAL_DB.host, port: LOCAL_DB.port, user: "flow_nogrant", password: noGrantPassword, database: name, max: 2 });
  guardPool.on("error", () => undefined);
  noGrantPool.on("error", () => undefined);
  return {
    adminPool,
    guardPool,
    webPool,
    noGrantPool,
    name,
    secrets,
    drop: async () => {
      await Promise.all([guardPool.end(), webPool.end(), noGrantPool.end(), adminPool.end()]).catch(() => undefined);
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
export * from "./web";

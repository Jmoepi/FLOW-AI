import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";

export type PgClientConfig = pg.ClientConfig;

/** The local Docker Postgres. Bound to loopback only (docker-compose.local-db.yml). */
export const LOCAL_DB = { host: "127.0.0.1", port: 54329, adminUser: "postgres", database: "flow_ai" } as const;
export const LOCAL_ENV_FILE = "local-db.env";

export interface LocalDbSecrets {
  adminPassword: string;
  guardPassword: string;
}

/** Reads (or on first use generates) the local DB passwords. The file lives in the gitignored .secrets directory. */
export function loadLocalDbSecrets(secretsDir: string, create: boolean): LocalDbSecrets | null {
  const file = path.join(secretsDir, LOCAL_ENV_FILE);
  if (!existsSync(file)) {
    if (!create) return null;
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const body = `FLOW_LOCAL_PG_PASSWORD=${randomBytes(24).toString("hex")}\nFLOW_LOCAL_GUARD_PASSWORD=${randomBytes(24).toString("hex")}\n`;
    writeFileSync(file, body, { mode: 0o600, flag: "wx" });
  }
  const values = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=([0-9a-f]+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) values.set(m[1], m[2]);
  }
  const adminPassword = values.get("FLOW_LOCAL_PG_PASSWORD");
  const guardPassword = values.get("FLOW_LOCAL_GUARD_PASSWORD");
  if (adminPassword === undefined || guardPassword === undefined) throw new Error(`${LOCAL_ENV_FILE} is malformed; delete it and re-run db:up (this resets the local database volume password, so also run db:down -v first)`);
  return { adminPassword, guardPassword };
}

export function localAdminConfig(secrets: LocalDbSecrets, database: string = LOCAL_DB.database): pg.ClientConfig {
  return { host: LOCAL_DB.host, port: LOCAL_DB.port, user: LOCAL_DB.adminUser, password: secrets.adminPassword, database };
}

export function localGuardConfig(secrets: LocalDbSecrets, database: string = LOCAL_DB.database): pg.ClientConfig {
  return { host: LOCAL_DB.host, port: LOCAL_DB.port, user: "flow_guard", password: secrets.guardPassword, database };
}

/**
 * Creates the flow_guard role if missing and sets its password server-side with format('%L'). The password never
 * appears in a SQL string built in JS and is never printed. Migration 0001 re-asserts the role's safe attributes.
 */
export async function ensureGuardRole(client: pg.Client, guardPassword: string): Promise<void> {
  await client.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_guard') THEN
    CREATE ROLE flow_guard LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END
$$`);
  await client.query("SELECT set_config('flow.pw', $1, false)", [guardPassword]);
  await client.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE flow_guard PASSWORD %L', current_setting('flow.pw')); END $$`);
  await client.query("RESET flow.pw");
}

/** Polls until the server accepts connections (or the deadline passes). Returns true when ready. */
export async function waitForPostgres(config: pg.ClientConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = new pg.Client({ ...config, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query("SELECT 1");
      await c.end();
      return true;
    } catch {
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

/** Connects as the local admin, makes sure flow_guard exists with its password, disconnects. */
export async function ensureLocalGuardRole(secrets: LocalDbSecrets): Promise<void> {
  const client = new pg.Client(localAdminConfig(secrets));
  await client.connect();
  try {
    await ensureGuardRole(client, secrets.guardPassword);
  } finally {
    await client.end();
  }
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Password of the owner web app role (flow_web). */
  webPassword: string;
}

function readValues(file: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=([0-9a-f]+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) values.set(m[1], m[2]);
  }
  return values;
}
/** Reads (or on first use generates) the local DB passwords. The file lives in the gitignored .secrets directory. */
export function loadLocalDbSecrets(secretsDir: string, create: boolean): LocalDbSecrets | null {
  const file = path.join(secretsDir, LOCAL_ENV_FILE);
  if (!existsSync(file)) {
    if (!create) return null;
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const body = `FLOW_LOCAL_PG_PASSWORD=${randomBytes(24).toString("hex")}\nFLOW_LOCAL_GUARD_PASSWORD=${randomBytes(24).toString("hex")}\nFLOW_LOCAL_WEB_PASSWORD=${randomBytes(24).toString("hex")}\n`;
    writeFileSync(file, body, { mode: 0o600, flag: "wx" });
  }
  const values = readValues(file);
  // Files written before M4 have no web password: add one (never printed) so existing setups keep working.
  if (!values.has("FLOW_LOCAL_WEB_PASSWORD") && values.has("FLOW_LOCAL_PG_PASSWORD")) {
    const body = readFileSync(file, "utf8");
    appendFileSync(file, `${body.endsWith("\n") ? "" : "\n"}FLOW_LOCAL_WEB_PASSWORD=${randomBytes(24).toString("hex")}\n`);
    return loadLocalDbSecrets(secretsDir, false);
  }
  const adminPassword = values.get("FLOW_LOCAL_PG_PASSWORD");
  const guardPassword = values.get("FLOW_LOCAL_GUARD_PASSWORD");
  const webPassword = values.get("FLOW_LOCAL_WEB_PASSWORD");
  if (adminPassword === undefined || guardPassword === undefined || webPassword === undefined) throw new Error(`${LOCAL_ENV_FILE} is malformed; delete it and re-run db:up (this resets the local database volume password, so also run db:down -v first)`);
  return { adminPassword, guardPassword, webPassword };
}

export function localAdminConfig(secrets: LocalDbSecrets, database: string = LOCAL_DB.database): pg.ClientConfig {
  return { host: LOCAL_DB.host, port: LOCAL_DB.port, user: LOCAL_DB.adminUser, password: secrets.adminPassword, database };
}

export function localGuardConfig(secrets: LocalDbSecrets, database: string = LOCAL_DB.database): pg.ClientConfig {
  return { host: LOCAL_DB.host, port: LOCAL_DB.port, user: "flow_guard", password: secrets.guardPassword, database };
}

export function localWebConfig(secrets: LocalDbSecrets, database: string = LOCAL_DB.database): pg.ClientConfig {
  return { host: LOCAL_DB.host, port: LOCAL_DB.port, user: "flow_web", password: secrets.webPassword, database };
}
const APP_ROLES = ["flow_guard", "flow_web"] as const;
/**
 * Creates an application role if missing and sets its password server-side with format('%L'). The password never
 * appears in a SQL string built in JS and is never printed. Migrations re-assert the role's safe attributes.
 */
export async function ensureRole(client: pg.Client, role: (typeof APP_ROLES)[number], password: string): Promise<void> {
  if (!APP_ROLES.includes(role)) throw new Error("unknown application role");
  await client.query("SELECT set_config('flow.role', $1, false)", [role]);
  await client.query(`DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('flow.role')) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', current_setting('flow.role'));
  END IF;
END
$$`);
  await client.query("SELECT set_config('flow.pw', $1, false)", [password]);
  await client.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L', current_setting('flow.role'), current_setting('flow.pw')); END $$`);
  await client.query("RESET flow.pw");
  await client.query("RESET flow.role");
}
export async function ensureGuardRole(client: pg.Client, guardPassword: string): Promise<void> {
  await ensureRole(client, "flow_guard", guardPassword);
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

/** Connects as the local admin, makes sure flow_guard and flow_web exist with their passwords, disconnects. */
export async function ensureLocalGuardRole(secrets: LocalDbSecrets): Promise<void> {
  const client = new pg.Client(localAdminConfig(secrets));
  await client.connect();
  try {
    await ensureGuardRole(client, secrets.guardPassword);
    await ensureRole(client, "flow_web", secrets.webPassword);
  } finally {
    await client.end();
  }
}

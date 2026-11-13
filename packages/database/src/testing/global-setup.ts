import pg from "pg";
import { loadLocalDbSecrets, localAdminConfig } from "../local";
import { NOT_REACHABLE_MESSAGE, SECRETS_DIR } from "./index";

/** vitest globalSetup for *.db.test.ts: fail loudly and early when the local Postgres is not up. */
export default async function setup(): Promise<void> {
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error(NOT_REACHABLE_MESSAGE);
  const c = new pg.Client({ ...localAdminConfig(secrets, "postgres"), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.query("SELECT 1");
  } catch {
    throw new Error(NOT_REACHABLE_MESSAGE);
  } finally {
    await c.end().catch(() => undefined);
  }
}

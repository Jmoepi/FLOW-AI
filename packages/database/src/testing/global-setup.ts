import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadLocalDbSecrets, localAdminConfig } from "../local";
import { NOT_REACHABLE_MESSAGE, SECRETS_DIR, TEST_RUN_ENV, dropTestDatabasesForRun } from "./index";
/**
 * vitest globalSetup for *.db.test.ts: fail loudly and early when the local Postgres is not up, tag this run, and drop
 * whatever throwaway databases the run left behind (a crashed or timed-out file never reaches its own afterAll).
 */
export default async function setup(): Promise<() => Promise<void>> {
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
  // Set before the workers start, so they inherit it and tag every database they create.
  const runId = randomBytes(8).toString("hex");
  process.env[TEST_RUN_ENV] = runId;
  return async () => {
    await dropTestDatabasesForRun(secrets, runId);
  };
}

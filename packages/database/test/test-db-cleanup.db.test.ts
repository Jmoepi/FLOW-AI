import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { localAdminConfig } from "../src/local";
import { TEST_RUN_ENV, createTestDatabase, dropTestDatabasesForRun, type TestDatabase } from "../src/testing";
/**
 * L-4: throwaway flow_test_* databases must not accumulate. The harness drops its own database in afterAll, and the
 * global teardown drops, by run tag, whatever a crashed or timed-out file left behind. This file proves the teardown
 * helper drops exactly the tagged databases and nothing else.
 */
const created: TestDatabase[] = [];
const extraDbs: string[] = [];
let admin: pg.Client | undefined;
const exists = async (name: string): Promise<boolean> => {
  const c = admin as pg.Client;
  return (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1;
};
afterAll(async () => {
  for (const db of created) await db.drop().catch(() => undefined);
  if (admin) {
    for (const n of extraDbs) await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(n)} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
async function createTagged(runId: string): Promise<TestDatabase> {
  const previous = process.env[TEST_RUN_ENV];
  process.env[TEST_RUN_ENV] = runId;
  try {
    const db = await createTestDatabase();
    created.push(db);
    return db;
  } finally {
    if (previous === undefined) delete process.env[TEST_RUN_ENV];
    else process.env[TEST_RUN_ENV] = previous;
  }
}
describe("test database cleanup", () => {
  it("drops the databases of one run and leaves other runs and unrelated databases alone", async () => {
    const mine = `unit-${randomBytes(6).toString("hex")}`;
    const other = `unit-${randomBytes(6).toString("hex")}`;
    const a = await createTagged(mine);
    const b = await createTagged(mine);
    const keep = await createTagged(other);
    admin = new pg.Client(localAdminConfig(a.secrets, "postgres"));
    await admin.connect();
    // A database that carries this run's tag but is NOT named flow_test_<12 hex> must never be dropped.
    const lookalike = `flow_ai_lookalike_${randomBytes(4).toString("hex")}`;
    extraDbs.push(lookalike);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(lookalike)}`);
    await admin.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(lookalike)} IS ${pg.escapeLiteral(`flow-test-run:${mine}`)}`);
    // An untagged flow_test_* database (for example one from a concurrent package run) is not this run's either.
    const untagged = `flow_test_${randomBytes(6).toString("hex")}`;
    extraDbs.push(untagged);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(untagged)}`);

    const dropped = await dropTestDatabasesForRun(a.secrets, mine);
    expect(dropped.sort()).toEqual([a.name, b.name].sort());
    expect(await exists(a.name)).toBe(false);
    expect(await exists(b.name)).toBe(false);
    expect(await exists(keep.name)).toBe(true);
    expect(await exists(lookalike)).toBe(true);
    expect(await exists(untagged)).toBe(true);
    expect(await exists("postgres")).toBe(true);
    expect(await dropTestDatabasesForRun(a.secrets, mine)).toEqual([]); // idempotent
  }, 120_000);
  it("rejects a malformed run id before touching the server", async () => {
    const db = await createTagged(`unit-${randomBytes(6).toString("hex")}`);
    await expect(dropTestDatabasesForRun(db.secrets, "x'; DROP DATABASE postgres; --")).rejects.toThrow(/invalid test run id/);
  }, 60_000);
  it("drop() removes a harness database and the global setup tags this run", async () => {
    const db = await createTagged(`unit-${randomBytes(6).toString("hex")}`);
    const c = new pg.Client(localAdminConfig(db.secrets, "postgres"));
    await c.connect();
    try {
      await db.drop();
      expect((await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [db.name])).rowCount).toBe(0);
    } finally {
      await c.end();
    }
    expect(process.env[TEST_RUN_ENV]).toMatch(/^[0-9a-f]{16}$/); // set by global-setup for this very run
  }, 60_000);
});

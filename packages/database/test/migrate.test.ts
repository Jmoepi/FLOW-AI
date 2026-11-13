import { describe, expect, it } from "vitest";
import { MigrationConfigError, assertMigrationTarget, loadMigrations, parseMigrateArgs } from "../src/migrate";

// Built at runtime: no literal credentials in the repo.
const pw = ["p", "w", Math.random().toString(36).slice(2)].join("");
const remote = (q = "") => `postgresql://user:${pw}@db.example.supabase.co:5432/postgres${q}`;

describe("assertMigrationTarget (host guard)", () => {
  it("accepts loopback hosts without --allow-remote", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => assertMigrationTarget(`postgresql://u:${pw}@${host}:54329/flow_ai`, false)).not.toThrow();
    }
  });
  it("refuses a remote host without --allow-remote and never echoes the URL or password", () => {
    let message = "";
    try {
      assertMigrationTarget(remote("?sslmode=require"), false);
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationConfigError);
      message = (e as Error).message;
    }
    expect(message).toContain("--allow-remote");
    expect(message).not.toContain(pw);
    expect(message).not.toContain("supabase.co");
  });
  it("with --allow-remote still requires TLS", () => {
    for (const q of ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow"]) {
      expect(() => assertMigrationTarget(remote(q), true)).toThrow(MigrationConfigError);
    }
    for (const q of ["?sslmode=require", "?sslmode=verify-ca", "?sslmode=verify-full"]) {
      expect(() => assertMigrationTarget(remote(q), true)).not.toThrow();
    }
  });
  it("rejects missing, malformed and non-postgres URLs without echoing them", () => {
    expect(() => assertMigrationTarget(undefined, false)).toThrow(/not set/);
    expect(() => assertMigrationTarget("", false)).toThrow(/not set/);
    const bad = `not a url ${pw}`;
    try {
      assertMigrationTarget(bad, false);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(pw);
    }
    expect(() => assertMigrationTarget(`http://localhost/${pw}`, false)).toThrow(/postgres:\/\//);
  });
  it("does not treat a lookalike hostname as local", () => {
    expect(() => assertMigrationTarget(`postgresql://u:${pw}@localhost.evil.example:5432/x`, false)).toThrow(MigrationConfigError);
    expect(() => assertMigrationTarget(`postgresql://u:${pw}@127.0.0.1.evil.example:5432/x`, false)).toThrow(MigrationConfigError);
  });
});

describe("parseMigrateArgs", () => {
  it("defaults to up", () => {
    expect(parseMigrateArgs([])).toEqual({ command: "up", allowRemote: false, local: false });
  });
  it("accepts a leading -- and the known flags", () => {
    expect(parseMigrateArgs(["--", "status", "--allow-remote"])).toEqual({ command: "status", allowRemote: true, local: false });
    expect(parseMigrateArgs(["--local"]).local).toBe(true);
  });
  it("rejects unknown flags, stray arguments, repeated commands and conflicting flags", () => {
    for (const bad of [["--force"], ["down"], ["up", "status"], ["--allow-remote=true"], ["--local", "--allow-remote"], ["x"]]) {
      expect(() => parseMigrateArgs(bad)).toThrow(MigrationConfigError);
    }
  });
});

describe("loadMigrations", () => {
  const files = loadMigrations();
  it("loads the ordered set with stable sha256 checksums", () => {
    expect(files.map((f) => f.version)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010"]);
    for (const f of files) expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loadMigrations().map((f) => f.checksum)).toEqual(files.map((f) => f.checksum));
  });
  it("never embeds a password or seed-shaped value", () => {
    for (const f of files) {
      expect(f.sql).not.toMatch(/PASSWORD\s+'/i);
      expect(f.sql).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{28,}\b/);
    }
  });
  it("enables and forces RLS for every created table", () => {
    const all = files.map((f) => f.sql).join("\n");
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBe(17);
    for (const t of tables) expect(all).toContain(`'${t}'`);
    expect(all).toContain("FORCE ROW LEVEL SECURITY");
  });
});

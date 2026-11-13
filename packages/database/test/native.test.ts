import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOCAL_DB,
  NATIVE_DIR_NAME,
  assertLoopbackHost,
  initdbArgs,
  isElevatedWindowsToken,
  nativePaths,
  parseNativeArgs,
  pgCtlStartArgs,
  planNativeUp,
  postgresServerOptions,
} from "../src/index";

describe("native local Postgres helpers", () => {
  const paths = nativePaths(path.join("repo", "root"));

  it("keeps data under the gitignored .local-pg directory", () => {
    expect(NATIVE_DIR_NAME).toBe(".local-pg");
    expect(paths.root).toBe(path.join("repo", "root", ".local-pg"));
    expect(paths.dataDir.startsWith(paths.root)).toBe(true);
    expect(paths.logFile.startsWith(paths.root)).toBe(true);
  });

  it("binds to loopback on the same port the launchers use", () => {
    expect(postgresServerOptions()).toBe(`-p ${String(LOCAL_DB.port)} -c listen_addresses=127.0.0.1`);
    expect(pgCtlStartArgs(paths)).toContain("-w");
  });

  it("refuses non-loopback hosts and bad ports", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "db.example.com", ""]) expect(() => assertLoopbackHost(host)).toThrow(/non-loopback/);
    expect(() => postgresServerOptions("0.0.0.0")).toThrow();
    expect(() => postgresServerOptions("127.0.0.1", 80)).toThrow(/Port/);
    expect(() => postgresServerOptions("127.0.0.1", 70000)).toThrow(/Port/);
    expect(() => postgresServerOptions("127.0.0.1", 54.5)).toThrow(/Port/);
  });

  it("passes the password by file with scram-sha-256, never as a plain argument", () => {
    const args = initdbArgs(paths, path.join("tmp", "pwfile"));
    expect(args).toContain("--auth=scram-sha-256");
    expect(args).toContain(`--pwfile=${path.join("tmp", "pwfile")}`);
    expect(args.some((a) => /password=/i.test(a))).toBe(false);
  });

  it("detects an elevated Windows token", () => {
    expect(isElevatedWindowsToken("Mandatory Label\\High Mandatory Level  Label  S-1-16-12288")).toBe(true);
    expect(isElevatedWindowsToken("Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192")).toBe(false);
  });

  it("parses commands strictly", () => {
    expect(parseNativeArgs(["up"]).command).toBe("up");
    expect(parseNativeArgs(["reset", "--", "--yes"])).toEqual({ command: "reset", yes: true });
    expect(parseNativeArgs(["reset"]).yes).toBe(false);
    expect(() => parseNativeArgs([])).toThrow(/Usage/);
    expect(() => parseNativeArgs(["up", "--yes"])).toThrow(/Usage/);
    expect(() => parseNativeArgs(["drop"])).toThrow(/Usage/);
  });

  it("plans idempotent starts and refuses a data dir without its password file", () => {
    expect(planNativeUp({ dataDirInitialised: false, running: false, secretsExist: false })).toBe("init-and-start");
    expect(planNativeUp({ dataDirInitialised: true, running: false, secretsExist: true })).toBe("start");
    expect(planNativeUp({ dataDirInitialised: true, running: true, secretsExist: true })).toBe("already-running");
    expect(planNativeUp({ dataDirInitialised: true, running: false, secretsExist: false })).toBe("refuse-missing-secrets");
  });
});

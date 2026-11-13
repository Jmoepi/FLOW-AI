import path from "node:path";
import { LOCAL_DB } from "./local";

/**
 * Pure helpers for the Docker-free local Postgres (`pnpm db:up:native`, embedded-postgres binaries). No I/O here, so
 * everything is unit-testable. The native server uses the same host, port, database, roles and .secrets/local-db.env as
 * the Docker one, so every launcher works unchanged. Development only; never used in deployment.
 */
export const NATIVE_DIR_NAME = ".local-pg";
export const NATIVE_DATA_SUBDIR = "data";
export const NATIVE_LOG_FILE = "postgres.log";

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

export interface NativePaths {
  root: string;
  dataDir: string;
  logFile: string;
}

export function nativePaths(repoRoot: string): NativePaths {
  const root = path.join(repoRoot, NATIVE_DIR_NAME);
  return { root, dataDir: path.join(root, NATIVE_DATA_SUBDIR), logFile: path.join(root, NATIVE_LOG_FILE) };
}

/** Refuses anything but a loopback host: the native server must never listen on a reachable interface. */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error("Refusing to run the local Postgres on a non-loopback host");
}

export function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer between 1024 and 65535");
}

/** The `-o` option string passed to pg_ctl start: loopback-only listen address and the fixed port. */
export function postgresServerOptions(host: string = LOCAL_DB.host, port: number = LOCAL_DB.port): string {
  assertLoopbackHost(host);
  assertValidPort(port);
  return `-p ${String(port)} -c listen_addresses=${host}`;
}

export function pgCtlStartArgs(paths: NativePaths, host: string = LOCAL_DB.host, port: number = LOCAL_DB.port): string[] {
  return ["start", "-D", paths.dataDir, "-l", paths.logFile, "-w", "-t", "60", "-o", postgresServerOptions(host, port)];
}

export function pgCtlStopArgs(paths: NativePaths): string[] {
  return ["stop", "-D", paths.dataDir, "-m", "fast", "-w", "-t", "60"];
}

export function pgCtlStatusArgs(paths: NativePaths): string[] {
  return ["status", "-D", paths.dataDir];
}

/** initdb arguments. The password is passed by file (never on the command line) and scram-sha-256 is required. */
export function initdbArgs(paths: NativePaths, passwordFile: string, user: string = LOCAL_DB.adminUser): string[] {
  return [`--pgdata=${paths.dataDir}`, "--auth=scram-sha-256", `--username=${user}`, `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"];
}

/** True when `whoami /groups` output shows a High (or System) integrity level, i.e. an elevated Windows shell. */
export function isElevatedWindowsToken(whoamiGroups: string): boolean {
  return /S-1-16-(12288|16384)\b/.test(whoamiGroups);
}

export const ELEVATED_MESSAGE =
  "This terminal is running as Administrator (elevated). PostgreSQL refuses to run with administrative rights. Open a normal, non-elevated terminal and run the command again.";

export type NativeCommand = "up" | "down" | "status" | "reset";
const NATIVE_COMMANDS: readonly string[] = ["up", "down", "status", "reset"];

export function parseNativeArgs(argv: readonly string[]): { command: NativeCommand; yes: boolean } {
  const [cmd, ...rest] = argv.filter((a) => a !== "--");
  const yes = rest.length === 1 && rest[0] === "--yes";
  const usage = "Usage: db-native <up|down|status|reset [--yes]>";
  if (cmd === undefined || !NATIVE_COMMANDS.includes(cmd)) throw new Error(usage);
  if (rest.length > 0 && !(cmd === "reset" && yes)) throw new Error(usage);
  return { command: cmd as NativeCommand, yes };
}

/** What `up` has to do given what is on disk. Pure so idempotency and the mismatch guard can be tested. */
export type NativeUpPlan = "init-and-start" | "start" | "already-running" | "refuse-missing-secrets";

export function planNativeUp(state: { dataDirInitialised: boolean; running: boolean; secretsExist: boolean }): NativeUpPlan {
  if (state.dataDirInitialised && !state.secretsExist) return "refuse-missing-secrets";
  if (state.running) return "already-running";
  return state.dataDirInitialised ? "start" : "init-and-start";
}

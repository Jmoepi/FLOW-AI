/**
 * Docker-free local Postgres lifecycle. Usage: pnpm db:up:native | db:down:native | db:status:native | db:reset:native -- --yes
 * Runs the embedded-postgres binaries (devDependency) from a gitignored data directory (.local-pg/), bound to 127.0.0.1:54329.
 * It uses the same database, roles and .secrets/local-db.env as the Docker path, so db:migrate, db:seed:demo, guard:dev,
 * dev:web, agent:run and test:db work unchanged. Passwords are random and never printed. Development only.
 * Child processes are spawned with argument arrays and no shell.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ELEVATED_MESSAGE,
  LOCAL_DB,
  NATIVE_DIR_NAME,
  ensureLocalDatabase,
  ensureLocalGuardRole,
  initdbArgs,
  isElevatedWindowsToken,
  loadLocalDbSecrets,
  localAdminConfig,
  nativePaths,
  parseNativeArgs,
  pgCtlStartArgs,
  pgCtlStatusArgs,
  pgCtlStopArgs,
  planNativeUp,
  waitForPostgres,
  type LocalDbSecrets,
  type NativePaths,
} from "../packages/database/src/index";
import { ROOT, SECRETS_DIR, toErrorMessage } from "./lib/common";

const PLATFORM_PACKAGES: Record<string, string> = {
  "win32-x64": "@embedded-postgres/windows-x64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
};

interface Binaries {
  initdb: string;
  pg_ctl: string;
}

async function loadBinaries(): Promise<Binaries> {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (pkg === undefined) throw new Error(`No embedded Postgres build for ${key}. Use the Docker path (pnpm db:up) or a locally installed PostgreSQL.`);
  try {
    // The platform package is a dependency of embedded-postgres, not of the repo root, so resolve it from there.
    const embeddedEntry = fileURLToPath(import.meta.resolve("embedded-postgres"));
    const resolved = createRequire(embeddedEntry).resolve(pkg);
    const mod = (await import(`file://${resolved.replace(/\\/g, "/")}`)) as Partial<Binaries>;
    if (typeof mod.initdb !== "string" || typeof mod.pg_ctl !== "string") throw new Error("unexpected package shape");
    return { initdb: mod.initdb, pg_ctl: mod.pg_ctl };
  } catch {
    throw new Error("The embedded Postgres binaries are missing. Run: pnpm install --frozen-lockfile");
  }
}

function assertNotElevated(): void {
  if (process.platform === "win32") {
    const r = spawnSync("whoami", ["/groups"], { encoding: "utf8", shell: false });
    if (r.status === 0 && isElevatedWindowsToken(r.stdout)) throw new Error(ELEVATED_MESSAGE);
  } else if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("PostgreSQL refuses to run as root. Run this as a normal user.");
  }
}

function run(file: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Starts the server through pg_ctl. The postgres process inherits pg_ctl's handles, so piping them would keep this
 * call open forever: output goes to the log file (pg_ctl -l) and we wait for pg_ctl itself to exit.
 */
function runDetached(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOCAL_DB.host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function isRunning(bins: Binaries, paths: NativePaths): Promise<boolean> {
  if (!existsSync(paths.dataDir)) return false;
  return (await run(bins.pg_ctl, pgCtlStatusArgs(paths))).code === 0;
}

async function initCluster(bins: Binaries, paths: NativePaths, secrets: LocalDbSecrets): Promise<void> {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const pwFile = path.join(paths.root, `.pw-${String(process.pid)}`);
  writeFileSync(pwFile, `${secrets.adminPassword}\n`, { mode: 0o600 });
  try {
    chmodSync(pwFile, 0o600);
    const r = await run(bins.initdb, initdbArgs(paths, pwFile));
    if (r.code !== 0) {
      rmSync(paths.dataDir, { recursive: true, force: true });
      throw new Error(`initdb failed:\n${r.output.trim()}`);
    }
  } finally {
    rmSync(pwFile, { force: true });
  }
}

async function up(bins: Binaries, paths: NativePaths): Promise<void> {
  assertNotElevated();
  const dataDirInitialised = existsSync(path.join(paths.dataDir, "PG_VERSION"));
  const secretsExist = existsSync(path.join(SECRETS_DIR, "local-db.env"));
  const running = await isRunning(bins, paths);
  const plan = planNativeUp({ dataDirInitialised, running, secretsExist });
  if (plan === "refuse-missing-secrets") {
    throw new Error(`${NATIVE_DIR_NAME}/ exists but .secrets/local-db.env is missing, so its password is unknown. Run: pnpm db:reset:native -- --yes (this wipes the native local data), then pnpm db:up:native`);
  }
  const secrets = loadLocalDbSecrets(SECRETS_DIR, true);
  if (secrets === null) throw new Error("could not load local database secrets");
  if (plan !== "already-running" && (await portInUse(LOCAL_DB.port))) {
    throw new Error(`Port ${String(LOCAL_DB.port)} on ${LOCAL_DB.host} is already in use (a Docker local database or another Postgres?). Stop it (pnpm db:down) and retry.`);
  }
  if (plan === "init-and-start") await initCluster(bins, paths, secrets);
  if (plan !== "already-running") {
    const code = await runDetached(bins.pg_ctl, pgCtlStartArgs(paths));
    if (code !== 0) throw new Error(`Postgres failed to start (exit ${String(code)}); see ${NATIVE_DIR_NAME}/postgres.log`);
  }
  if (!(await waitForPostgres(localAdminConfig(secrets, "postgres"), 60_000))) throw new Error("Postgres did not become ready in time");
  await ensureLocalDatabase(secrets);
  await ensureLocalGuardRole(secrets);
  console.log(`Native local Postgres ready on ${LOCAL_DB.host}:${String(LOCAL_DB.port)} (data: ${NATIVE_DIR_NAME}/). Next: pnpm db:migrate --local`);
}

async function down(bins: Binaries, paths: NativePaths): Promise<void> {
  if (!(await isRunning(bins, paths))) {
    console.log("Native local Postgres is not running.");
    return;
  }
  const r = await run(bins.pg_ctl, pgCtlStopArgs(paths));
  if (r.code !== 0) throw new Error(`Postgres failed to stop:\n${r.output.trim()}`);
  console.log("Native local Postgres stopped. Data is kept; run pnpm db:up:native to start it again.");
}

async function status(bins: Binaries, paths: NativePaths): Promise<void> {
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (!(await isRunning(bins, paths)) || secrets === null) {
    console.log("Native local Postgres is not running. Run: pnpm db:up:native");
    return;
  }
  const ready = await waitForPostgres(localAdminConfig(secrets, "postgres"), 3000);
  console.log(ready ? `Native local Postgres is up on ${LOCAL_DB.host}:${String(LOCAL_DB.port)}.` : "Native local Postgres process exists but is not accepting connections; see .local-pg/postgres.log");
}

async function reset(bins: Binaries, paths: NativePaths, yes: boolean): Promise<void> {
  if (!yes) throw new Error("This deletes ALL native local database data. Re-run with: pnpm db:reset:native -- --yes");
  if (path.basename(paths.root) !== NATIVE_DIR_NAME || path.dirname(paths.root) !== ROOT) throw new Error("unexpected data directory; refusing to delete");
  if (await isRunning(bins, paths)) await down(bins, paths);
  rmSync(paths.root, { recursive: true, force: true });
  console.log(`Removed ${NATIVE_DIR_NAME}/. Passwords in .secrets/local-db.env are kept. Run: pnpm db:up:native`);
}

async function main(): Promise<void> {
  const { command, yes } = parseNativeArgs(process.argv.slice(2));
  const paths = nativePaths(ROOT);
  const bins = await loadBinaries();
  if (command === "up") await up(bins, paths);
  else if (command === "down") await down(bins, paths);
  else if (command === "status") await status(bins, paths);
  else await reset(bins, paths, yes);
}

main().catch((err: unknown) => {
  console.error(`db-native failed: ${toErrorMessage(err)}`);
  process.exitCode = 1;
});

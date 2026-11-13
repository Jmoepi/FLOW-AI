/**
 * Local Postgres lifecycle (Docker). Usage: pnpm db:up | pnpm db:down | pnpm db:status
 * Generates random passwords into the gitignored .secrets/local-db.env on first use. Passwords are never printed.
 * `docker compose` is spawned with an argument array and no shell.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  LOCAL_DB,
  ensureLocalGuardRole,
  loadLocalDbSecrets,
  localAdminConfig,
  waitForPostgres,
} from "../packages/database/src/index";
import { ROOT, SECRETS_DIR, toErrorMessage } from "./lib/common";

const COMPOSE_FILE = path.join(ROOT, "docker-compose.local-db.yml");
const COMMANDS = ["up", "down", "status"] as const;
type Command = (typeof COMMANDS)[number];

function parseArgs(argv: readonly string[]): Command {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [cmd, ...rest] = args;
  if (rest.length > 0 || cmd === undefined || !(COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error("Usage: db-local <up|down|status>");
  }
  return cmd as Command;
}

function compose(args: string[], passwordEnv: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
      shell: false,
      env: { ...process.env, ...passwordEnv },
    });
    child.once("error", (err) => {
      reject(new Error(`Could not run docker: ${(err as NodeJS.ErrnoException).code ?? "error"}. Is Docker Desktop installed and running?`));
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const cmd = parseArgs(process.argv.slice(2));
  const secrets = loadLocalDbSecrets(SECRETS_DIR, cmd === "up");
  if (secrets === null) {
    console.log("Local database is not set up. Run: pnpm db:up");
    if (cmd === "status") return;
  }
  const env = secrets ? { FLOW_LOCAL_PG_PASSWORD: secrets.adminPassword } : { FLOW_LOCAL_PG_PASSWORD: "unused" };
  if (cmd === "down") {
    process.exitCode = await compose(["down"], env);
    return;
  }
  if (cmd === "status") {
    if (!secrets) return;
    const ready = await waitForPostgres(localAdminConfig(secrets), 3000);
    console.log(ready ? `Local Postgres is up on ${LOCAL_DB.host}:${String(LOCAL_DB.port)}.` : "Local Postgres is not reachable. Run: pnpm db:up");
    return;
  }
  if (!secrets) return;
  const code = await compose(["up", "-d", "--wait"], env);
  if (code !== 0) {
    process.exitCode = code;
    return;
  }
  if (!(await waitForPostgres(localAdminConfig(secrets), 60_000))) throw new Error("Postgres did not become ready in time");
  await ensureLocalGuardRole(secrets);
  console.log(`Local Postgres ready on ${LOCAL_DB.host}:${String(LOCAL_DB.port)}. Next: pnpm db:migrate`);
}

main().catch((err: unknown) => {
  console.error(`db-local failed: ${toErrorMessage(err)}`);
  process.exitCode = 1;
});

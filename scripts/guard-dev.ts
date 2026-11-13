/**
 * Starts the payment guard locally against the local Docker database (.secrets/local-db.env), Testnet only.
 * Usage: pnpm guard:dev [-- --business <uuid>]
 * Prerequisites: pnpm db:up && pnpm db:migrate, and a seeded business. Nothing secret is printed.
 */
import { LOCAL_DB, loadLocalDbSecrets } from "../packages/database/src/index";
import { SECRETS_DIR, readPublicWallets, toErrorMessage } from "./lib/common";
import { startGuard } from "./lib/guard-launcher";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: readonly string[]): { businessId?: string } {
  const args = argv.filter((a) => a !== "--");
  if (args.length === 0) return {};
  const [flag, value, ...rest] = args;
  if (flag !== "--business" || value === undefined || !UUID_RE.test(value) || rest.length > 0) throw new Error("Usage: guard-dev [--business <uuid>]");
  return { businessId: value };
}

function main(): void {
  const { businessId } = parseArgs(process.argv.slice(2));
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error("No local database set up. Run: pnpm db:up && pnpm db:migrate");
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  if (!treasury) throw new Error("No treasury wallet in the secrets file.");
  const databaseUrl = `postgres://flow_guard:${encodeURIComponent(secrets.guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${LOCAL_DB.database}`;
  const guard = startGuard({ databaseUrl, port: 4002, treasuryLabel: treasury.label, ...(businessId !== undefined ? { businessId } : {}) });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void guard.stop().then(() => process.exit(0)));
  guard.child.once("exit", (code) => process.exit(code ?? 1));
  console.log("Guard starting on 127.0.0.1:4002 (Testnet). The agent token is random and is not printed; use pnpm m3:e2e for a full demo.");
}

try {
  main();
} catch (err) {
  console.error(`guard-dev failed: ${toErrorMessage(err)}`);
  process.exit(1);
}

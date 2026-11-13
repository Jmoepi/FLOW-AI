/**
 * Applies SQL migrations. Usage: pnpm db:migrate [up|status] [--local] [--allow-remote]
 * Target: DATABASE_URL, or the local Docker database (.secrets/local-db.env) when DATABASE_URL is unset or --local is given.
 * A non-local host needs --allow-remote and TLS (optional DATABASE_SSL_CA_FILE = verified TLS against that CA). The connection string is never printed.
 */
import { redactError } from "../packages/contracts/src/index";
import {
  assertMigrationTarget,
  loadLocalDbSecrets,
  localAdminConfig,
  parseMigrateArgs,
  type PgClientConfig,
  runMigrations,
  connectionConfigWithCa,
  sslCaFileFromEnv,
} from "../packages/database/src/index";
import { SECRETS_DIR } from "./lib/common";

async function main(): Promise<void> {
  const args = parseMigrateArgs(process.argv.slice(2));
  const url = args.local ? undefined : process.env.DATABASE_URL;
  let config: PgClientConfig;
  if (url === undefined || url === "") {
    const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
    if (secrets === null) throw new Error("No local database set up. Run: pnpm db:up (or set DATABASE_URL)");
    config = localAdminConfig(secrets);
  } else {
    const caFile = sslCaFileFromEnv(process.env);
    assertMigrationTarget(url, args.allowRemote, caFile !== undefined);
    config = caFile !== undefined ? connectionConfigWithCa(url, caFile) : { connectionString: url };
  }
  const report = await runMigrations(config, { dryRun: args.command === "status", log: (l) => console.log(l) });
  if (args.command === "status") {
    console.log(`applied: ${String(report.skipped.length)}, pending: ${report.pending.length === 0 ? "none" : report.pending.join(", ")}`);
  } else {
    console.log(report.applied.length === 0 ? "Nothing to apply; database is up to date." : `Applied ${String(report.applied.length)} migration(s).`);
  }
}

main().catch((err: unknown) => {
  console.error(`db-migrate failed: ${redactError(err)}`);
  process.exitCode = 1;
});

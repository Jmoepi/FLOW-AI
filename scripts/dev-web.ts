/**
 * Starts the owner web app locally on 127.0.0.1:3000 against the local Docker database as the flow_web role.
 * Usage: pnpm dev:web [--supabase]  (--supabase: flow_web on the hosted Supabase database, verified TLS)
 * Prerequisites: pnpm db:up && pnpm db:migrate && pnpm db:seed:demo. Nothing secret is printed.
 */
import { LOCAL_DB, loadLocalDbSecrets } from "../packages/database/src/index";
import { SECRETS_DIR, toErrorMessage } from "./lib/common";
import { loadRolePasswords, loadSupabaseTarget, supabaseCaFile, supabaseUrl } from "./lib/supabase";
import { startWeb } from "./lib/web-launcher";

function main(): void {
  const supabase = process.argv.includes("--supabase");
  let databaseUrl: string;
  if (supabase) {
    process.env.DATABASE_SSL_CA_FILE = supabaseCaFile(); // path to the public CA; the launcher forwards it to the child
    databaseUrl = supabaseUrl("flow_web", loadSupabaseTarget(), loadRolePasswords());
  } else {
    const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
    if (secrets === null) throw new Error("No local database set up. Run: pnpm db:up && pnpm db:migrate && pnpm db:seed:demo");
    databaseUrl = `postgres://flow_web:${encodeURIComponent(secrets.webPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${LOCAL_DB.database}`;
  }
  const web = startWeb({ databaseUrl, port: 3000 });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => web.stop());
  web.child.once("exit", (code) => process.exit(code ?? 1));
  console.log("Web app starting on http://127.0.0.1:3000 (Testnet display only; no signing key in this process).");
}

try {
  main();
} catch (err) {
  console.error(`dev-web failed: ${toErrorMessage(err)}`);
  process.exit(1);
}

/**
 * Creates flow_guard and flow_web on the hosted Supabase database (if missing), sets random passwords (generated once,
 * stored only in the gitignored .secrets/supabase-roles.env) and proves each role can log in through the session pooler.
 * Usage: pnpm db:supabase:roles [--rotate]. Requires migrations 0001 and 0006 (roles) to be applied. Prints statuses only.
 */
import { redactError } from "../packages/contracts/src/index";
import { Client, currentRoleSummary, ensureRole } from "../packages/database/src/index";
import { loadRolePasswords, loadSupabaseTarget, randomPassword, saveRolePasswords, supabaseConfig } from "./lib/supabase";

async function main(): Promise<void> {
  const rotate = process.argv.includes("--rotate");
  const target = loadSupabaseTarget();
  const existing = loadRolePasswords();
  const pw = {
    flow_guard: rotate || existing.flow_guard === undefined ? randomPassword() : existing.flow_guard,
    flow_web: rotate || existing.flow_web === undefined ? randomPassword() : existing.flow_web,
  };
  // Save first: a password set on the server must never exist without a copy.
  saveRolePasswords(pw);
  const admin = new Client({ ...supabaseConfig("admin", target, pw), connectionTimeoutMillis: 15_000 });
  await admin.connect();
  try {
    for (const role of ["flow_guard", "flow_web"] as const) {
      await ensureRole(admin, role, pw[role]);
      console.log(`${role}: role ready, password set (stored in .secrets/supabase-roles.env)`);
    }
  } finally {
    await admin.end();
  }
  for (const role of ["flow_guard", "flow_web"] as const) {
    const c = new Client({ ...supabaseConfig(role, target, pw), connectionTimeoutMillis: 15_000 });
    try {
      await c.connect();
      const row = await currentRoleSummary(c);
      console.log(`${role}: pooler login ok (current_user=${row.user}, superuser=${String(row.superuser)}, bypassrls=${String(row.bypassrls)})`);
    } finally {
      await c.end().catch(() => undefined);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`supabase-roles failed: ${redactError(err)}`);
  process.exitCode = 1;
});

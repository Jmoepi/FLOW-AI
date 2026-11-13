/**
 * Read-only verification of the hosted Supabase database (spec 13.1A/13.3): RLS on every table, role attributes,
 * anon/authenticated/PUBLIC have no access, denied writes for flow_guard and flow_web (each inside a transaction that is
 * always rolled back) and the audit chain objects. Usage: pnpm db:supabase:verify. Prints names, booleans and counts only.
 * Exit code 1 when any check fails. The SQL lives in packages/database/src/supabase-checks.ts.
 */
import { redactError } from "../packages/contracts/src/index";
import { Client, verifyAdminChecks, verifyRoleChecks, type VerifyResult } from "../packages/database/src/index";
import { loadRolePasswords, loadSupabaseTarget, supabaseConfig } from "./lib/supabase";

function report(results: readonly VerifyResult[]): number {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail === "" ? "" : ` (${r.detail})`}`);
  return results.filter((r) => !r.ok).length;
}

async function main(): Promise<void> {
  const target = loadSupabaseTarget();
  const pw = loadRolePasswords();
  let failures = 0;
  const admin = new Client({ ...supabaseConfig("admin", target, pw), connectionTimeoutMillis: 15_000 });
  await admin.connect();
  try {
    failures += report(await verifyAdminChecks(admin));
  } finally {
    await admin.end();
  }
  for (const role of ["flow_guard", "flow_web"] as const) {
    const c = new Client({ ...supabaseConfig(role, target, pw), connectionTimeoutMillis: 15_000 });
    await c.connect();
    try {
      failures += report(await verifyRoleChecks(c, role));
    } finally {
      await c.end().catch(() => undefined);
    }
  }
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${String(failures)} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`supabase-verify failed: ${redactError(err)}`);
  process.exitCode = 1;
});

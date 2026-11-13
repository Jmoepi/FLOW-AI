/**
 * Static deploy-readiness verifier (`pnpm deploy:check`). Reads repository files only: no network, no environment values, no
 * login to any host, nothing is deployed. Exits 1 when any check fails.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeployChecks } from "./lib/deploy-check";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = runDeployChecks(ROOT);
for (const c of checks) process.stdout.write(`${c.ok ? "ok  " : "FAIL"} ${c.name} (${c.detail})\n`);
const failed = checks.filter((c) => !c.ok).length;
process.stdout.write(`${String(checks.length - failed)}/${String(checks.length)} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;

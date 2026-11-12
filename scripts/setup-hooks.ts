/**
 * Opt-in: points this clone's git hooks at the versioned scripts/git-hooks directory.
 * Run `pnpm setup:hooks` yourself; nothing runs this automatically (no postinstall).
 * It only sets `core.hooksPath` for THIS repository (local config). Undo: git config --unset core.hooksPath
 */
import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./lib/common";

const HOOKS_DIR = "scripts/git-hooks";
execFileSync("git", ["config", "--local", "core.hooksPath", HOOKS_DIR], { cwd: ROOT, stdio: "inherit" });
try {
  chmodSync(path.join(ROOT, HOOKS_DIR, "pre-commit"), 0o755);
} catch {
  /* best effort; Git for Windows runs hooks without the exec bit */
}
console.log(`core.hooksPath set to ${HOOKS_DIR}. The pre-commit secret-scan is now active for this clone.`);

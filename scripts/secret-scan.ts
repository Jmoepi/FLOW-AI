/**
 * Secret-scan guard (spec 10.4). Fails (exit 1) on XRPL family seeds, API keys/JWTs, or non-empty
 * secret env assignments in scanned files. Never prints the matched value, only file:line and rule.
 *
 * Scope: in a git repo, staged + tracked + untracked-not-ignored files; otherwise the workspace tree
 * (skipping node_modules, .git, .secrets, and .env* except .env.example). Use as a pre-commit hook
 * or in CI: `pnpm secret-scan`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/common";

const SKIP_DIRS = new Set(["node_modules", ".git", ".secrets", "dist", "build", ".next", "coverage"]);
const SKIP_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".zip"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);

const SECRET_ENV_NAMES = [
  "XRPL_DEMO_SIGNER_SEED",
  "XRPL_REGULAR_KEY_SEED",
  "OWNER_TREASURY_MASTER_SEED",
  "AI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "AGENT_TO_PAYMENT_GUARD_TOKEN",
  "DATABASE_URL",
  "GUARD_DATABASE_URL",
];

const SEED_RE = /\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/g;
const KEY_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "openai-style-api-key", re: /\bsk-[A-Za-z0-9]{32,}/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];
const ENV_ASSIGN_RE = new RegExp(`^\\s*(?:export\\s+)?(${SECRET_ENV_NAMES.join("|")})\\s*=\\s*(.*?)\\s*$`);

function isPlaceholder(v: string): boolean {
  const t = v.replace(/^["']|["']$/g, "");
  return t === "" || t.startsWith("<") || t.startsWith("#");
}

function looksLikeSeed(token: string): boolean {
  // Real seeds are mixed-case/digit base58; skip plain lowercase words.
  return /[0-9A-Z]/.test(token.slice(1));
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (!(name.startsWith(".env") && name !== ".env.example")) {
      out.push(full);
    }
  }
}

function collectFiles(): { files: string[]; mode: string } {
  if (git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true") {
    const lists = [
      git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
      git(["ls-files"]),
      git(["ls-files", "--others", "--exclude-standard"]),
    ];
    const names = new Set(lists.flatMap((l) => (l ?? "").split("\n").filter(Boolean)));
    return { files: [...names].map((n) => path.join(ROOT, n)), mode: "git (staged + tracked + untracked-not-ignored)" };
  }
  const files: string[] = [];
  walk(ROOT, files);
  return { files, mode: "filesystem walk (not a git repository)" };
}

interface Finding {
  file: string;
  line: number;
  rule: string;
}

function scanFile(file: string): Finding[] {
  const base = path.basename(file);
  if (SKIP_FILES.has(base) || SKIP_EXT.has(path.extname(file).toLowerCase())) return [];
  const findings: Finding[] = [];
  if (base.startsWith(".env") && base !== ".env.example") {
    return [{ file, line: 0, rule: "env-file-in-scope (.env* must be gitignored)" }];
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(ROOT, file);
  text.split(/\r?\n/).forEach((line, i) => {
    const m = ENV_ASSIGN_RE.exec(line);
    if (m && !isPlaceholder(m[2] ?? "")) findings.push({ file: rel, line: i + 1, rule: `non-empty ${m[1]}` });
    for (const token of line.match(SEED_RE) ?? []) {
      if (looksLikeSeed(token)) findings.push({ file: rel, line: i + 1, rule: "xrpl-family-seed-pattern" });
    }
    for (const { rule, re } of KEY_RULES) if (re.test(line)) findings.push({ file: rel, line: i + 1, rule });
  });
  return findings;
}

const { files, mode } = collectFiles();
const findings = files.flatMap(scanFile);
console.log(`secret-scan: scanned ${files.length} files via ${mode}`);
if (findings.length > 0) {
  for (const f of findings) console.error(`  FOUND ${f.rule} at ${f.file}:${f.line} (value not shown)`);
  console.error(`secret-scan: FAIL (${findings.length} finding(s)). Treat any real secret as compromised and replace it.`);
  process.exit(1);
}
console.log("secret-scan: PASS");

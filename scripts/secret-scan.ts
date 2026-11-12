/**
 * Secret-scan guard (spec 10.4). Fails (exit 1) on XRPL family seeds, hex private keys, signed tx blobs,
 * API keys, JWT/Bearer tokens, PEM private keys, non-empty secret env assignments and forbidden file names.
 * Never prints the matched value, only file:line and rule. Rules live in packages/contracts/src/redact.ts.
 *
 * Scope in a git repo: the STAGED content from the index (what would actually be committed), plus tracked and
 * untracked-not-ignored files from the working tree. If git cannot be queried the whole workspace is walked
 * instead (fail safe: a broken git never means "scan nothing"). Use as a pre-commit hook or in CI.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { forbiddenFileRule, scanText } from "../packages/contracts/src/index";
import { ROOT } from "./lib/common";

const SKIP_DIRS = new Set(["node_modules", ".git", ".secrets", "dist", "build", ".next", "coverage"]);
const SKIP_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".zip"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);
const MAX_BYTES = 20 * 1024 * 1024;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_BYTES });
  } catch {
    return null;
  }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else {
      out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
}

interface Source {
  rel: string;
  /** "index" = staged content, "tree" = working tree. */
  from: "index" | "tree";
}

function collectSources(): { sources: Source[]; mode: string } {
  const inRepo = git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  const staged = inRepo ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]) : null;
  const tracked = inRepo ? git(["ls-files", "-z"]) : null;
  const untracked = inRepo ? git(["ls-files", "-z", "--others", "--exclude-standard"]) : null;
  if (inRepo && staged !== null && tracked !== null && untracked !== null) {
    const split = (z: string) => z.split("\0").filter(Boolean);
    const stagedSet = new Set(split(staged));
    const treeSet = new Set([...split(tracked), ...split(untracked)]);
    const sources: Source[] = [...stagedSet].map((rel) => ({ rel, from: "index" as const }));
    for (const rel of treeSet) sources.push({ rel, from: "tree" });
    return { sources, mode: "git (staged index content + tracked + untracked-not-ignored)" };
  }
  const files: string[] = [];
  walk(ROOT, files);
  return { sources: files.map((rel) => ({ rel, from: "tree" as const })), mode: "filesystem walk (git unavailable or not a repository)" };
}

interface Finding {
  file: string;
  line: number;
  rule: string;
}

function readSource(s: Source): string | null {
  if (s.from === "index") return git(["show", `:${s.rel}`]);
  try {
    if (statSync(path.join(ROOT, s.rel)).size > MAX_BYTES) return null;
    return readFileSync(path.join(ROOT, s.rel), "utf8");
  } catch {
    return "";
  }
}

function scanSource(s: Source): Finding[] {
  const base = path.posix.basename(s.rel);
  const forbidden = forbiddenFileRule(s.rel);
  if (forbidden) return [{ file: s.rel, line: 0, rule: forbidden }];
  if (SKIP_FILES.has(base) || SKIP_EXT.has(path.extname(s.rel).toLowerCase())) return [];
  const text = readSource(s);
  if (text === null) return [{ file: s.rel, line: 0, rule: "unreadable-or-too-large (cannot prove it is clean)" }];
  return scanText(text).map((f) => ({ file: `${s.rel}${s.from === "index" ? " (staged)" : ""}`, ...f }));
}

const { sources, mode } = collectSources();
const findings = sources.flatMap(scanSource);
console.log(`secret-scan: scanned ${sources.length} file versions via ${mode}`);
if (findings.length > 0) {
  for (const f of findings) console.error(`  FOUND ${f.rule} at ${f.file}:${f.line} (value not shown)`);
  console.error(`secret-scan: FAIL (${findings.length} finding(s)). Treat any real secret as compromised and replace it.`);
  process.exit(1);
}
console.log("secret-scan: PASS");

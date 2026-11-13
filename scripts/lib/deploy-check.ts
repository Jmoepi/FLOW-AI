import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
/**
 * Static deploy-readiness checks. They read repository files only: no network, no environment, no secret values. The same
 * function backs `pnpm deploy:check` and a unit test (apps/web/test/deploy-readiness.test.ts), so `pnpm test` covers it.
 */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export type Process = "web" | "guard" | "agent";
export type Level = "required" | "optional" | "forbidden" | "-";
export const PROCESSES: readonly Process[] = ["web", "guard", "agent"];
const LEVELS: readonly string[] = ["required", "optional", "forbidden", "-"];
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const read = (root: string, rel: string): string => readFileSync(path.join(root, rel), "utf8");
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === ".next" ? [] : e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}
/** Parses the table between the env-matrix markers in docs/deployment.md. Cells must be one of the four level words. */
export function parseMatrix(markdown: string): { rows: Map<string, Record<Process, Level>>; problems: string[] } {
  const problems: string[] = [];
  const rows = new Map<string, Record<Process, Level>>();
  const a = markdown.indexOf("<!-- env-matrix:start -->");
  const b = markdown.indexOf("<!-- env-matrix:end -->");
  if (a < 0 || b < a) return { rows, problems: ["env matrix markers are missing"] };
  for (const line of markdown.slice(a, b).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4) {
      problems.push(`row has ${String(cells.length)} cells: ${line.slice(0, 40)}`);
      continue;
    }
    const [rawName = "", web = "", guard = "", agent = ""] = cells;
    if (rawName === "Variable" || /^-+$/.test(rawName)) continue;
    const name = rawName.replace(/`/g, "");
    if (!NAME.test(name)) problems.push(`not a variable name: ${name.slice(0, 30)}`);
    for (const c of [web, guard, agent]) if (!LEVELS.includes(c)) problems.push(`${name}: cell is not a level word`);
    rows.set(name, { web: web as Level, guard: guard as Level, agent: agent as Level });
  }
  return { rows, problems };
}
const SECRET_ENV_NAME = /SEED|SECRET|PASSWORD|TOKEN|DATABASE_URL|API_KEY|PRIVATE|SERVICE_ROLE/i;
/** Names read by framework or platform code rather than by our own source. */
const PLATFORM_READ: Record<Process, readonly string[]> = { web: ["PORT", "NODE_ENV"], guard: ["NODE_ENV"], agent: [] };
export function runDeployChecks(root: string): Check[] {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void out.push({ name, ok, detail });
  // ---- Dockerfile ----
  const docker = existsSync(path.join(root, "Dockerfile")) ? read(root, "Dockerfile") : "";
  const stages = docker.split(/^FROM /m).slice(1);
  add("Dockerfile exists with web, guard and agent targets", ["web", "guard", "agent"].every((t) => docker.split("\n").some((l) => l.startsWith("FROM ") && l.trimEnd().endsWith(` AS ${t}`))), "targets");
  const runtime = stages.filter((s) => /\sAS (web|guard|agent)\s*(\n|$)/.test(s.split("\n")[0] ?? ""));
  add("every runtime target runs as a non-root user", runtime.length === 3 && runtime.every((s) => /^USER (node|[1-9][0-9]*)\s*$/m.test(s)), `${String(runtime.length)} runtime stages`);
  add("every runtime target has a HEALTHCHECK", runtime.length === 3 && runtime.every((s) => /^HEALTHCHECK /m.test(s)), "healthcheck");
  const envArg = docker.split("\n").filter((l) => /^\s*(ENV|ARG)\s/.test(l));
  add("no ENV or ARG in the Dockerfile carries a secret-like name", envArg.every((l) => !SECRET_ENV_NAME.test(l)), `${String(envArg.length)} ENV/ARG lines`);
  add("the Dockerfile never copies an env or secrets file or a certificate", !/COPY[^\n]*(\.env(?!\.example)|\.secrets|\.crt|\.pem)/.test(docker), "copy lines");
  // ---- .dockerignore ----
  const ignore = existsSync(path.join(root, ".dockerignore")) ? read(root, ".dockerignore").split("\n").map((l) => l.trim()) : [];
  const need = [".env", ".env.*", ".secrets", ".local-pg", "*.crt", "*.pem", ".git", ".agents", "node_modules", ".next"];
  const missing = need.filter((n) => !ignore.includes(n));
  add(".dockerignore excludes env files, secrets, certificates, git, agents and build output", missing.length === 0, missing.length === 0 ? "complete" : `missing: ${missing.join(", ")}`);
  // ---- env matrix ----
  const docPath = path.join(root, "docs", "deployment.md");
  const { rows, problems } = existsSync(docPath) ? parseMatrix(read(root, "docs/deployment.md")) : { rows: new Map<string, Record<Process, Level>>(), problems: ["docs/deployment.md is missing"] };
  add("the env matrix parses and lists names and level words only (no values)", problems.length === 0 && rows.size > 10, problems.length === 0 ? `${String(rows.size)} names` : problems.join("; "));
  const agentBad = [...rows].filter(([n, l]) => l.agent !== "forbidden" && l.agent !== "-" && /DATABASE|SEED|SUPABASE|SERVICE_ROLE|SIGNER|EXECUTION_ENABLED/i.test(n)).map(([n]) => n);
  add("the agent column has no database, signer, Supabase or kill switch name", agentBad.length === 0, agentBad.join(", ") || "clean");
  const seed = rows.get("XRPL_DEMO_SIGNER_SEED");
  add("the signer seed is guard only: required for the guard and forbidden for web and agent", seed?.guard === "required" && seed.web === "forbidden" && seed.agent === "forbidden", "XRPL_DEMO_SIGNER_SEED");
  const webCfg = read(root, "apps/web/src/server/config.ts");
  const forbiddenInWeb = [...webCfg.matchAll(/^\s+"([A-Z0-9_]+)",?$/gm)].map((m) => m[1] as string);
  const notMarked = forbiddenInWeb.filter((n) => rows.get(n) !== undefined && rows.get(n)?.web !== "forbidden");
  add("names the web config refuses are forbidden for web in the matrix", notMarked.length === 0 && forbiddenInWeb.length >= 5, notMarked.join(", ") || `${String(forbiddenInWeb.length)} names`);
  const roots: Record<Process, string[]> = {
    web: ["apps/web/src", "packages/database/src/tls.ts"],
    guard: ["apps/payment-guard/src", "packages/database/src/tls.ts"],
    agent: ["apps/agent/src"],
  };
  for (const p of PROCESSES) {
    const text = roots[p].flatMap((r) => (r.endsWith(".ts") ? [path.join(root, r)] : sourceFiles(path.join(root, r)))).filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    const unknown = [...rows].filter(([n, l]) => (l[p] === "required" || l[p] === "optional") && !text.includes(`"${n}"`) && !text.includes(`${n}:`) && !text.includes(`.${n}`) && !PLATFORM_READ[p].includes(n)).map(([n]) => n);
    add(`every ${p} variable in the matrix is read by the ${p} code`, unknown.length === 0, unknown.join(", ") || "all read");
  }
  // ---- .env.example carries every non-forbidden name ----
  const example = existsSync(path.join(root, ".env.example")) ? read(root, ".env.example") : "";
  const exampleNames = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string));
  const notInExample = [...rows].filter(([, l]) => PROCESSES.some((p) => l[p] === "required" || l[p] === "optional")).map(([n]) => n).filter((n) => !exampleNames.has(n));
  add(".env.example lists every variable in the matrix", notInExample.length === 0, notInExample.join(", ") || "complete");
  // Public defaults (network URLs, limits, the Testnet issuer) are allowed; anything secret-like or a URL with credentials is not.
  const filled = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)].filter((m) => SECRET_ENV_NAME.test(m[1] as string) || /:\/\/[^/\s]*@/.test(m[2] as string)).map((m) => m[1] as string);
  add(".env.example has no value for any secret-like name and no credentials in a URL", filled.length === 0, filled.join(", ") || "clean");
  // ---- scripts ----
  const pkg = JSON.parse(read(root, "package.json")) as { scripts: Record<string, string> };
  const wanted = ["build", "start:web", "start:guard", "start:agent", "web:size", "deploy:check"];
  const noScript = wanted.filter((s) => pkg.scripts[s] === undefined);
  add("root scripts exist for build and the three start entry points", noScript.length === 0, noScript.join(", ") || "present");
  for (const [app, expect] of [["apps/payment-guard", "tsx src/main.ts"], ["apps/agent", "tsx src/main.ts --serve"]] as const) {
    const p = JSON.parse(read(root, `${app}/package.json`)) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    add(`${app} starts with tsx from its own dependencies`, p.scripts.start === expect && /^\d+\.\d+\.\d+$/.test(p.dependencies.tsx ?? ""), "start script and exact tsx pin");
  }
  const web = JSON.parse(read(root, "apps/web/package.json")) as { scripts: Record<string, string> };
  add("the web start scripts use next start and never next dev", /^next start /.test(web.scripts.start ?? "") && /^next start /.test(web.scripts["start:public"] ?? ""), "web scripts");
  // ---- deployment guide wording ----
  const doc = existsSync(docPath) ? read(root, "docs/deployment.md") : "";
  for (const phrase of ["Testnet", "no deployment has been made", "WEB_TRUSTED_PROXY_HOPS", "DATABASE_SSL_CA_FILE", "HSTS", "login_attempts", "session pooler"]) add(`docs/deployment.md covers: ${phrase}`, doc.includes(phrase), phrase);
  return out;
}

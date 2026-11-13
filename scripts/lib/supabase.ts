/**
 * Helpers for the user's hosted Supabase database. Everything is assembled in memory from the gitignored .env
 * (DATABASE_URL, the admin session-pooler string) and .secrets/supabase-roles.env (passwords of flow_guard and flow_web).
 * Nothing here prints or logs a URL, a password or the contents of the CA file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import { connectionConfigWithCa, sslCaFileFromEnv, type PgClientConfig } from "../../packages/database/src/index";
import { SECRETS_DIR } from "./common";

export const SUPABASE_ROLES_FILE = path.join(SECRETS_DIR, "supabase-roles.env");
export const SUPABASE_CA_DEFAULT = path.join(SECRETS_DIR, "supabase-ca.crt");
export type SupabaseRole = "admin" | "flow_guard" | "flow_web";

export interface SupabaseTarget {
  host: string;
  port: number;
  database: string;
  /** Supavisor tenant suffix (the project ref), taken from the admin user name "postgres.<ref>". */
  ref: string;
  caFile: string;
  adminUser: string;
  adminPassword: string;
}

/** DATABASE_SSL_CA_FILE from the environment, else .secrets/supabase-ca.crt. */
export function supabaseCaFile(): string {
  const f = sslCaFileFromEnv(process.env) ?? SUPABASE_CA_DEFAULT;
  if (!existsSync(f)) throw new Error("No Supabase CA file. Set DATABASE_SSL_CA_FILE or place it at .secrets/supabase-ca.crt");
  return f;
}

export function loadSupabaseTarget(): SupabaseTarget {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined || raw === "") throw new Error("DATABASE_URL is not set");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const user = decodeURIComponent(url.username);
  const m = /^[^.]+\.([a-z0-9]+)$/.exec(user);
  if (m === null || m[1] === undefined) throw new Error("DATABASE_URL user is not of the form <user>.<project-ref> (session pooler)");
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    ref: m[1],
    caFile: supabaseCaFile(),
    adminUser: user,
    adminPassword: decodeURIComponent(url.password),
  };
}

export function loadRolePasswords(): Partial<Record<"flow_guard" | "flow_web", string>> {
  if (!existsSync(SUPABASE_ROLES_FILE)) return {};
  const p = dotenv.parse(readFileSync(SUPABASE_ROLES_FILE, "utf8"));
  return {
    ...(p.FLOW_GUARD_PASSWORD !== undefined && p.FLOW_GUARD_PASSWORD.length >= 32 ? { flow_guard: p.FLOW_GUARD_PASSWORD } : {}),
    ...(p.FLOW_WEB_PASSWORD !== undefined && p.FLOW_WEB_PASSWORD.length >= 32 ? { flow_web: p.FLOW_WEB_PASSWORD } : {}),
  };
}

/** Writes the gitignored roles file (mode 0600 where the OS honours it). Never prints. */
export function saveRolePasswords(pw: { flow_guard: string; flow_web: string }): void {
  mkdirSync(SECRETS_DIR, { recursive: true });
  writeFileSync(SUPABASE_ROLES_FILE, `# Supabase application role passwords. Gitignored. Never commit or print.\nFLOW_GUARD_PASSWORD=${pw.flow_guard}\nFLOW_WEB_PASSWORD=${pw.flow_web}\n`, { mode: 0o600 });
}

export function randomPassword(): string {
  return randomBytes(36).toString("base64url"); // 48 chars, URL-safe
}

/** Client settings (verified TLS) for one role. Role user names are "<role>.<project-ref>" on the session pooler. */
export function supabaseConfig(role: SupabaseRole, target: SupabaseTarget, passwords: Partial<Record<"flow_guard" | "flow_web", string>>): PgClientConfig {
  const user = role === "admin" ? target.adminUser : `${role}.${target.ref}`;
  const pw = role === "admin" ? target.adminPassword : passwords[role];
  if (pw === undefined) throw new Error(`No password for ${role}. Run: pnpm db:supabase:roles`);
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@${target.host}:${String(target.port)}/${encodeURIComponent(target.database)}`;
  return connectionConfigWithCa(url, target.caFile);
}

/** postgresql:// string for a child process (kept in memory; carries the password; never print it). */
export function supabaseUrl(role: Exclude<SupabaseRole, "admin">, target: SupabaseTarget, passwords: Partial<Record<"flow_guard" | "flow_web", string>>): string {
  const pw = passwords[role];
  if (pw === undefined) throw new Error(`No password for ${role}. Run: pnpm db:supabase:roles`);
  return `postgresql://${encodeURIComponent(`${role}.${target.ref}`)}:${encodeURIComponent(pw)}@${target.host}:${String(target.port)}/${encodeURIComponent(target.database)}`;
}

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { MoneyString } from "@flow-ai/contracts";
import { DbError } from "../errors";
import { iso, isoOrNull, moneyIn, moneyOut, moneyOutOrNull, run, runOne, uuid, type Queryable } from "../db";
import { withTransaction } from "../tx";
import type { ActorType, RegularKeyState, SigningKeyMode } from "./types";
/**
 * Repositories for the owner web app (role flow_web). Every tenant read/write takes the business id from the verified
 * session, and the database ALSO enforces it: withWebTx sets the transaction-local app.business_id that the RLS policies
 * of migration 0006 compare against. Nothing here ever accepts a business id from a request body.
 */
/** Runs `fn` in a transaction scoped to one business (RLS key app.business_id, transaction-local). */
export async function withWebTx<T>(pool: Pool, businessId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const id = uuid(businessId);
  return withTransaction(pool, async (client) => {
    await run(client, "SELECT set_config('app.business_id', $1, true)", [id]);
    return fn(client);
  });
}
/** Transaction scoped to one user (membership lookup at login, before the business is known). */
export async function withWebUserTx<T>(pool: Pool, userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const id = uuid(userId);
  return withTransaction(pool, async (client) => {
    await run(client, "SELECT set_config('app.user_id', $1, true)", [id]);
    return fn(client);
  });
}
export type WebRole = "owner" | "viewer";
const ROLES: readonly WebRole[] = ["owner", "viewer"];
const HEX64 = /^[0-9a-f]{64}$/;
function hex64(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new DbError("INVALID_INPUT");
  return value;
}
function webRole(value: unknown): WebRole {
  if (typeof value !== "string" || !ROLES.includes(value as WebRole)) throw new DbError("DATA_INTEGRITY");
  return value as WebRole;
}
// ---------------------------------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------------------------------
export interface CredentialRow {
  user_id: string;
  email: string;
  password_hash: string;
  failed_count: number;
  locked_until: string | null;
}
interface CredentialDbRow {
  user_id: string;
  email: string;
  password_hash: string;
  failed_count: number;
  locked_until: unknown;
}
const CRED_COLS = "user_id, email, password_hash, failed_count, locked_until";
const mapCredential = (r: CredentialDbRow): CredentialRow => ({ ...r, locked_until: isoOrNull(r.locked_until) });
const EMAIL = z.string().min(3).max(254);
function emailIn(value: unknown): string {
  const r = EMAIL.safeParse(value);
  if (!r.success) throw new DbError("INVALID_INPUT");
  return r.data.toLowerCase();
}
export async function findCredentialByEmail(q: Queryable, email: string): Promise<CredentialRow | null> {
  const r = await runOne<CredentialDbRow>(q, `SELECT ${CRED_COLS} FROM web_credentials WHERE email = $1`, [emailIn(email)]);
  return r ? mapCredential(r) : null;
}
export async function findCredentialById(q: Queryable, userId: string): Promise<CredentialRow | null> {
  const r = await runOne<CredentialDbRow>(q, `SELECT ${CRED_COLS} FROM web_credentials WHERE user_id = $1`, [uuid(userId)]);
  return r ? mapCredential(r) : null;
}
/** Seed/setup only (the flow_web role has no INSERT right on credentials; use the admin pool). */
export async function createCredential(q: Queryable, c: { email: string; password_hash: string }): Promise<CredentialRow> {
  const r = await runOne<CredentialDbRow>(
    q,
    `INSERT INTO web_credentials (email, password_hash) VALUES ($1, $2) RETURNING ${CRED_COLS}`,
    [emailIn(c.email), c.password_hash],
  );
  if (!r) throw new DbError("DB_ERROR");
  return mapCredential(r);
}
/** Seed/setup only (admin pool). */
export async function addBusinessMember(q: Queryable, m: { business_id: string; user_id: string; role: WebRole }): Promise<void> {
  await run(q, "INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, $3)", [uuid(m.business_id), uuid(m.user_id), webRole(m.role)]);
}
/** Seed/setup only (admin pool): the id of the business with exactly this name, if any. */
export async function findBusinessIdByName(q: Queryable, name: string): Promise<string | null> {
  const r = await runOne<{ id: string }>(q, "SELECT id FROM businesses WHERE name = $1", [name]);
  return r ? r.id : null;
}
/** Seed/setup only (admin pool). */
export async function hasBusinessMember(q: Queryable, businessId: string, userId: string): Promise<boolean> {
  const r = await runOne<{ ok: number }>(q, "SELECT 1 AS ok FROM business_members WHERE business_id = $1 AND user_id = $2", [uuid(businessId), uuid(userId)]);
  return r !== null;
}
export interface LockPolicy {
  /** Failures before the first lock. */
  threshold: number;
  baseSeconds: number;
  maxSeconds: number;
}
/** Atomically counts a failure and, from `threshold` on, sets an exponentially growing lock (capped). */
export async function recordLoginFailure(q: Queryable, userId: string, now: Date, lock: LockPolicy): Promise<{ failed_count: number; locked_until: string | null }> {
  const r = await runOne<{ failed_count: number; locked_until: unknown }>(
    q,
    `UPDATE web_credentials
        SET failed_count = failed_count + 1,
            locked_until = CASE WHEN failed_count + 1 >= $2
              THEN $5::timestamptz + make_interval(secs => LEAST($4::float8, $3::float8 * power(2, LEAST(failed_count + 1 - $2, 20))))
              ELSE locked_until END
      WHERE user_id = $1
      RETURNING failed_count, locked_until`,
    [uuid(userId), lock.threshold, lock.baseSeconds, lock.maxSeconds, now],
  );
  if (!r) throw new DbError("NOT_FOUND");
  return { failed_count: r.failed_count, locked_until: isoOrNull(r.locked_until) };
}
export async function resetLoginFailures(q: Queryable, userId: string): Promise<void> {
  await run(q, "UPDATE web_credentials SET failed_count = 0, locked_until = NULL WHERE user_id = $1", [uuid(userId)]);
}
export async function updatePasswordHash(q: Queryable, userId: string, passwordHash: string): Promise<void> {
  await run(q, "UPDATE web_credentials SET password_hash = $2 WHERE user_id = $1", [uuid(userId), passwordHash]);
}
export interface MembershipRow {
  business_id: string;
  role: WebRole;
}
/** Must run inside withWebUserTx (RLS compares user_id with app.user_id). */
export async function getMembership(q: Queryable, userId: string): Promise<MembershipRow | null> {
  const r = await runOne<{ business_id: string; role: string }>(
    q,
    "SELECT business_id, role FROM business_members WHERE user_id = $1 ORDER BY created_at, id LIMIT 1",
    [uuid(userId)],
  );
  return r ? { business_id: r.business_id, role: webRole(r.role) } : null;
}
// ---------------------------------------------------------------------------------------------------------------------
// Sessions (only the sha256 of the token is stored)
// ---------------------------------------------------------------------------------------------------------------------
export interface WebSessionRow {
  id_hash: string;
  user_id: string;
  business_id: string;
  role: WebRole;
  csrf_hash: string;
  created_at: string;
  last_seen_at: string;
  authenticated_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}
interface SessionDbRow {
  id_hash: string;
  user_id: string;
  business_id: string;
  role: string;
  csrf_hash: string;
  created_at: unknown;
  last_seen_at: unknown;
  authenticated_at: unknown;
  absolute_expires_at: unknown;
  revoked_at: unknown;
}
const SESSION_COLS = "id_hash, user_id, business_id, role, csrf_hash, created_at, last_seen_at, authenticated_at, absolute_expires_at, revoked_at";
function mapSession(r: SessionDbRow): WebSessionRow {
  return {
    id_hash: r.id_hash,
    user_id: r.user_id,
    business_id: r.business_id,
    role: webRole(r.role),
    csrf_hash: r.csrf_hash,
    created_at: iso(r.created_at),
    last_seen_at: iso(r.last_seen_at),
    authenticated_at: iso(r.authenticated_at),
    absolute_expires_at: iso(r.absolute_expires_at),
    revoked_at: isoOrNull(r.revoked_at),
  };
}
export interface NewSession {
  id_hash: string;
  user_id: string;
  business_id: string;
  role: WebRole;
  csrf_hash: string;
  now: Date;
  absolute_expires_at: Date;
  ip_hash?: string | null;
  ua_hash?: string | null;
}
export async function createSession(q: Queryable, s: NewSession): Promise<WebSessionRow> {
  const r = await runOne<SessionDbRow>(
    q,
    `INSERT INTO web_sessions (id_hash, user_id, business_id, role, csrf_hash, created_at, last_seen_at, authenticated_at, absolute_expires_at, ip_hash, ua_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9) RETURNING ${SESSION_COLS}`,
    [hex64(s.id_hash), uuid(s.user_id), uuid(s.business_id), webRole(s.role), hex64(s.csrf_hash), s.now, s.absolute_expires_at, s.ip_hash === undefined || s.ip_hash === null ? null : hex64(s.ip_hash), s.ua_hash === undefined || s.ua_hash === null ? null : hex64(s.ua_hash)],
  );
  if (!r) throw new DbError("DB_ERROR");
  return mapSession(r);
}
export async function getSessionByHash(q: Queryable, idHash: string): Promise<WebSessionRow | null> {
  const r = await runOne<SessionDbRow>(q, `SELECT ${SESSION_COLS} FROM web_sessions WHERE id_hash = $1`, [hex64(idHash)]);
  return r ? mapSession(r) : null;
}
export async function touchSession(q: Queryable, idHash: string, now: Date): Promise<void> {
  await run(q, "UPDATE web_sessions SET last_seen_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL", [hex64(idHash), now]);
}
export async function revokeSession(q: Queryable, idHash: string, now: Date): Promise<void> {
  await run(q, "UPDATE web_sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL", [hex64(idHash), now]);
}
/** Returns how many sessions were revoked. */
export async function revokeAllSessionsForUser(q: Queryable, userId: string, now: Date): Promise<number> {
  const rows = await run<{ id_hash: string }>(q, "UPDATE web_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING id_hash", [uuid(userId), now]);
  return rows.length;
}
/** Revokes sessions past their absolute expiry (housekeeping; rows are kept for the record). */
export async function revokeExpiredSessions(q: Queryable, now: Date): Promise<number> {
  const rows = await run<{ id_hash: string }>(q, "UPDATE web_sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND absolute_expires_at <= $1 RETURNING id_hash", [now]);
  return rows.length;
}
// ---------------------------------------------------------------------------------------------------------------------
// Login attempt counters (fixed windows, keyed by a hash)
// ---------------------------------------------------------------------------------------------------------------------
export async function bumpAttempt(q: Queryable, keyHash: string, windowStart: Date): Promise<number> {
  const r = await runOne<{ attempts: number }>(
    q,
    `INSERT INTO login_attempts (key_hash, window_start, attempts) VALUES ($1, $2, 1)
     ON CONFLICT (key_hash, window_start) DO UPDATE SET attempts = login_attempts.attempts + 1
     RETURNING attempts`,
    [hex64(keyHash), windowStart],
  );
  if (!r) throw new DbError("DB_ERROR");
  return r.attempts;
}
/** Dev tooling only: deletes every login-attempt counter (they are keyed by one-way hashes, so per-user deletion is impossible). Returns rows removed. */
export async function clearLoginAttempts(q: Queryable): Promise<number> {
  const rows = await run<{ key_hash: string }>(q, "DELETE FROM login_attempts RETURNING key_hash");
  return rows.length;
}
export async function getAttempts(q: Queryable, keyHash: string, windowStart: Date): Promise<number> {
  const r = await runOne<{ attempts: number }>(q, "SELECT attempts FROM login_attempts WHERE key_hash = $1 AND window_start = $2", [hex64(keyHash), windowStart]);
  return r?.attempts ?? 0;
}
// ---------------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------------
const AssetsSchema = z.array(z.strictObject({ currency: z.string().min(1), issuer: z.string().min(1) }));
export interface WebPolicyRow {
  id: string;
  business_id: string;
  enabled: boolean;
  max_payment_amount: MoneyString;
  daily_spend_limit: MoneyString;
  minimum_reserve: MoneyString;
  allowed_assets: { currency: string; issuer: string }[];
  valid_until: string | null;
  version: number;
  updated_by: string | null;
  updated_at: string;
}
interface WebPolicyDbRow {
  id: string;
  business_id: string;
  enabled: boolean;
  max_payment_amount: unknown;
  daily_spend_limit: unknown;
  minimum_reserve: unknown;
  allowed_assets: unknown;
  valid_until: unknown;
  version: number;
  updated_by: string | null;
  updated_at: unknown;
}
const WEB_POLICY_COLS = "id, business_id, enabled, max_payment_amount, daily_spend_limit, minimum_reserve, allowed_assets, valid_until, version, updated_by, updated_at";
function mapWebPolicy(r: WebPolicyDbRow): WebPolicyRow {
  const assets = AssetsSchema.safeParse(r.allowed_assets);
  if (!assets.success) throw new DbError("DATA_INTEGRITY");
  return {
    id: r.id,
    business_id: r.business_id,
    enabled: r.enabled,
    max_payment_amount: moneyOut(r.max_payment_amount),
    daily_spend_limit: moneyOut(r.daily_spend_limit),
    minimum_reserve: moneyOut(r.minimum_reserve),
    allowed_assets: assets.data,
    valid_until: isoOrNull(r.valid_until),
    version: r.version,
    updated_by: r.updated_by,
    updated_at: iso(r.updated_at),
  };
}
export async function getPolicyForWeb(q: Queryable, businessId: string): Promise<WebPolicyRow | null> {
  const r = await runOne<WebPolicyDbRow>(q, `SELECT ${WEB_POLICY_COLS} FROM treasury_policies WHERE business_id = $1`, [uuid(businessId)]);
  return r ? mapWebPolicy(r) : null;
}
/** Row-locks the policy for the rest of the transaction so concurrent owner writes serialise. */
export async function lockPolicyForWeb(q: Queryable, businessId: string): Promise<WebPolicyRow | null> {
  const r = await runOne<WebPolicyDbRow>(q, `SELECT ${WEB_POLICY_COLS} FROM treasury_policies WHERE business_id = $1 FOR UPDATE`, [uuid(businessId)]);
  return r ? mapWebPolicy(r) : null;
}
export interface PolicyPatch {
  enabled: boolean;
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  allowed_assets: readonly { currency: string; issuer: string }[];
  valid_until: string | null;
}
/**
 * Optimistic-concurrency update: returns the new row, or null when the stored version differs from `expectedVersion`
 * (or the tenant has no policy). Bumps version and stamps who changed it and when.
 */
export async function updatePolicyVersioned(q: Queryable, businessId: string, expectedVersion: number, patch: PolicyPatch, actorId: string, now: Date): Promise<WebPolicyRow | null> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2_000_000_000) throw new DbError("INVALID_INPUT");
  const assets = AssetsSchema.safeParse(patch.allowed_assets);
  if (!assets.success || assets.data.length > 20) throw new DbError("INVALID_INPUT");
  if (patch.valid_until !== null && Number.isNaN(Date.parse(patch.valid_until))) throw new DbError("INVALID_INPUT");
  const r = await runOne<WebPolicyDbRow>(
    q,
    `UPDATE treasury_policies
        SET enabled = $3, max_payment_amount = $4, daily_spend_limit = $5, minimum_reserve = $6, allowed_assets = $7::jsonb,
            valid_until = $8, version = version + 1, updated_by = $9, updated_at = $10
      WHERE business_id = $1 AND version = $2
      RETURNING ${WEB_POLICY_COLS}`,
    [
      uuid(businessId),
      expectedVersion,
      patch.enabled,
      moneyIn(patch.max_payment_amount, true),
      moneyIn(patch.daily_spend_limit, true),
      moneyIn(patch.minimum_reserve, true),
      JSON.stringify(assets.data),
      patch.valid_until,
      uuid(actorId),
      now,
    ],
  );
  return r ? mapWebPolicy(r) : null;
}
export async function getBusinessForWeb(q: Queryable, businessId: string): Promise<{ id: string; name: string; timezone: string } | null> {
  return runOne<{ id: string; name: string; timezone: string }>(q, "SELECT id, name, timezone FROM businesses WHERE id = $1", [uuid(businessId)]);
}
// ---------------------------------------------------------------------------------------------------------------------
// Suppliers (web may only flip is_approved / is_active)
// ---------------------------------------------------------------------------------------------------------------------
export interface WebSupplierRow {
  id: string;
  name: string;
  xrpl_address: string;
  country_code: string;
  is_approved: boolean;
  is_active: boolean;
  updated_at: string;
}
interface SupplierDbRow extends Omit<WebSupplierRow, "updated_at"> {
  updated_at: unknown;
}
const SUPPLIER_COLS = "id, name, xrpl_address, country_code, is_approved, is_active, updated_at";
const mapSupplier = (r: SupplierDbRow): WebSupplierRow => ({ ...r, updated_at: iso(r.updated_at) });
export async function listSuppliersForBusiness(q: Queryable, businessId: string): Promise<WebSupplierRow[]> {
  const rows = await run<SupplierDbRow>(q, `SELECT ${SUPPLIER_COLS} FROM suppliers WHERE business_id = $1 ORDER BY name, id LIMIT 500`, [uuid(businessId)]);
  return rows.map(mapSupplier);
}
/** Row-locked read inside a transaction; null for an unknown id or another tenant's id. */
export async function lockSupplierForWeb(q: Queryable, businessId: string, id: string): Promise<WebSupplierRow | null> {
  const r = await runOne<SupplierDbRow>(q, `SELECT ${SUPPLIER_COLS} FROM suppliers WHERE business_id = $1 AND id = $2 FOR UPDATE`, [uuid(businessId), uuid(id)]);
  return r ? mapSupplier(r) : null;
}
export async function setSupplierFlags(q: Queryable, businessId: string, id: string, patch: { is_approved?: boolean | undefined; is_active?: boolean | undefined }, now: Date): Promise<WebSupplierRow | null> {
  const r = await runOne<SupplierDbRow>(
    q,
    `UPDATE suppliers SET is_approved = COALESCE($3, is_approved), is_active = COALESCE($4, is_active), updated_at = $5
      WHERE business_id = $1 AND id = $2 RETURNING ${SUPPLIER_COLS}`,
    [uuid(businessId), uuid(id), patch.is_approved ?? null, patch.is_active ?? null, now],
  );
  return r ? mapSupplier(r) : null;
}
// ---------------------------------------------------------------------------------------------------------------------
// Audit (read) and web-side append
// ---------------------------------------------------------------------------------------------------------------------
export interface WebAuditRow {
  id: string;
  seq: number;
  actor_type: ActorType;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
}
interface AuditDbRow extends Omit<WebAuditRow, "seq" | "created_at"> {
  seq: string;
  created_at: unknown;
}
/** Newest first (ORDER BY the bigint column, not the text alias). `beforeSeq` pages backwards; the limit is bounded. Hashes are not exposed to the browser. */
export async function listAuditForBusiness(q: Queryable, businessId: string, opts: { limit?: number; beforeSeq?: number } = {}): Promise<WebAuditRow[]> {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DbError("INVALID_INPUT");
  const before = opts.beforeSeq ?? null;
  if (before !== null && (!Number.isInteger(before) || before < 1 || before > Number.MAX_SAFE_INTEGER)) throw new DbError("INVALID_INPUT");
  const rows = await run<AuditDbRow>(
    q,
    `SELECT id, seq::text AS seq, actor_type, actor_id, event_type, entity_type, entity_id, metadata, request_id, created_at
       FROM audit_events WHERE business_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
      ORDER BY audit_events.seq DESC LIMIT $3`,
    [uuid(businessId), before, limit],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq), created_at: iso(r.created_at) }));
}
// ---------------------------------------------------------------------------------------------------------------------
// Overview reads
// ---------------------------------------------------------------------------------------------------------------------
export interface OverviewData {
  wallet_id: string | null;
  rlusd_balance: MoneyString | null;
  balance_as_of: string | null;
  held_today: MoneyString;
  /** Guard signing key (M7): the stored mode and the latest observed RegularKey state. Public status only. */
  signing_key: { mode: SigningKeyMode; regular_key_state: RegularKeyState | null } | null;
  invoice_counts: { open: number; blocked: number; processing: number };
}
export async function getOverviewData(q: Queryable, businessId: string, businessDate: string): Promise<OverviewData> {
  const id = uuid(businessId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new DbError("INVALID_INPUT");
  const snap = await runOne<{ wallet_id: string; rlusd_balance: unknown; as_of: unknown; signing_key_mode: SigningKeyMode; regular_key_state: RegularKeyState | null }>(
    q,
    `SELECT w.id AS wallet_id, w.signing_key_mode, s.rlusd_balance, s.as_of, s.regular_key_state
       FROM treasury_wallets w LEFT JOIN LATERAL (
         SELECT rlusd_balance, as_of, regular_key_state FROM balance_snapshots WHERE wallet_id = w.id ORDER BY as_of DESC, id LIMIT 1
       ) s ON true
      WHERE w.business_id = $1 AND w.is_active ORDER BY w.created_at, w.id LIMIT 1`,
    [id],
  );
  const held = await runOne<{ total: unknown }>(
    q,
    "SELECT COALESCE(sum(amount), 0) AS total FROM daily_spend_reservations WHERE business_id = $1 AND business_date = $2 AND status IN ('reserved','committed')",
    [id, businessDate],
  );
  const counts = await run<{ status: string; n: string }>(
    q,
    "SELECT status, count(*)::text AS n FROM invoices WHERE business_id = $1 AND status IN ('open','blocked','processing') GROUP BY status",
    [id],
  );
  const n = (status: string): number => Number(counts.find((c) => c.status === status)?.n ?? "0");
  return {
    wallet_id: snap?.wallet_id ?? null,
    rlusd_balance: moneyOutOrNull(snap?.rlusd_balance ?? null),
    balance_as_of: snap?.as_of === undefined || snap.as_of === null ? null : iso(snap.as_of),
    held_today: moneyOut(typeof held?.total === "string" ? held.total : "0"),
    signing_key: snap ? { mode: snap.signing_key_mode, regular_key_state: snap.regular_key_state ?? null } : null,
    invoice_counts: { open: n("open"), blocked: n("blocked"), processing: n("processing") },
  };
}

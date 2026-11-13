import { DbError } from "../errors";
import { iso, moneyIn, moneyOut, moneyOutOrNull, run, runOne, uuid, type Queryable } from "../db";
import type { ActorType, AuditRow, SnapshotRow } from "./types";

interface SnapshotDbRow {
  id: string;
  wallet_id: string;
  rlusd_balance: unknown;
  xrp_balance: unknown;
  as_of: unknown;
  ledger_index: number | null;
}

function mapSnapshot(r: SnapshotDbRow): SnapshotRow {
  return { id: r.id, wallet_id: r.wallet_id, rlusd_balance: moneyOutOrNull(r.rlusd_balance), xrp_balance: moneyOut(r.xrp_balance), as_of: iso(r.as_of), ledger_index: r.ledger_index };
}

export async function insertSnapshot(
  q: Queryable,
  s: { wallet_id: string; rlusd_balance: string | null; xrp_balance: string; ledger_index: number | null },
): Promise<SnapshotRow> {
  const row = await runOne<SnapshotDbRow>(
    q,
    `INSERT INTO balance_snapshots (wallet_id, rlusd_balance, xrp_balance, as_of, ledger_index)
     VALUES ($1, $2, $3, now(), $4) RETURNING id, wallet_id, rlusd_balance, xrp_balance, as_of, ledger_index`,
    [uuid(s.wallet_id), s.rlusd_balance === null ? null : moneyIn(s.rlusd_balance, true), moneyIn(s.xrp_balance, true), s.ledger_index],
  );
  if (!row) throw new DbError("DB_ERROR");
  return mapSnapshot(row);
}

export async function getLatestSnapshot(q: Queryable, walletId: string): Promise<SnapshotRow | null> {
  const r = await runOne<SnapshotDbRow>(
    q,
    `SELECT id, wallet_id, rlusd_balance, xrp_balance, as_of, ledger_index
       FROM balance_snapshots WHERE wallet_id = $1 ORDER BY as_of DESC, id LIMIT 1`,
    [uuid(walletId)],
  );
  return r ? mapSnapshot(r) : null;
}

export interface NewAuditEvent {
  business_id: string;
  actor_type: ActorType;
  actor_id?: string | undefined;
  event_type: string;
  entity_type: string;
  entity_id: string;
  /** Must not contain secrets, seeds, tokens or signed blobs. */
  metadata?: Record<string, unknown> | undefined;
  request_id?: string | undefined;
}

interface AuditDbRow extends Omit<AuditRow, "seq" | "created_at"> {
  seq: string;
  created_at: unknown;
}

const AUDIT_COLS = "id, business_id, seq::text AS seq, prev_hash, row_hash, actor_type, actor_id, event_type, entity_type, entity_id, metadata, request_id, created_at";

function mapAudit(r: AuditDbRow): AuditRow {
  return { ...r, seq: Number(r.seq), created_at: iso(r.created_at) };
}

/** Appends an event. seq/prev_hash/row_hash/created_at are computed by the database trigger, never by the caller. */
export async function appendAudit(q: Queryable, e: NewAuditEvent): Promise<AuditRow> {
  const row = await runOne<AuditDbRow>(
    q,
    `INSERT INTO audit_events (business_id, seq, prev_hash, row_hash, actor_type, actor_id, event_type, entity_type, entity_id, metadata, request_id)
     VALUES ($1, 0, '', '', $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${AUDIT_COLS}`,
    [uuid(e.business_id), e.actor_type, e.actor_id ?? null, e.event_type, e.entity_type, e.entity_id, JSON.stringify(e.metadata ?? {}), e.request_id ?? null],
  );
  if (!row) throw new DbError("DB_ERROR");
  return mapAudit(row);
}

export async function listAuditForEntity(q: Queryable, entityType: string, entityId: string, limit = 100): Promise<AuditRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DbError("INVALID_INPUT");
  const rows = await run<AuditDbRow>(
    q,
    `SELECT ${AUDIT_COLS} FROM audit_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, seq LIMIT $3`,
    [entityType, entityId, limit],
  );
  return rows.map(mapAudit);
}

export async function verifyAuditChain(q: Queryable, businessId: string): Promise<boolean> {
  const r = await runOne<{ ok: boolean }>(q, "SELECT verify_audit_chain($1) AS ok", [uuid(businessId)]);
  return r?.ok === true;
}

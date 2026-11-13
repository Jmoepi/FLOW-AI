import { PaymentStatusSchema, type MoneyString, type PaymentStatus } from "@flow-ai/contracts";
import { DbError } from "../errors";
import { iso, isoOrNull, moneyIn, moneyOut, moneyOutOrNull, run, runOne, uuid, type Queryable } from "../db";
import type { PaymentRow } from "./types";

interface PaymentDbRow extends Omit<PaymentRow, "amount" | "delivered_amount" | "requested_at" | "submitted_at" | "validated_at" | "updated_at" | "status"> {
  amount: unknown;
  delivered_amount: unknown;
  status: string;
  requested_at: unknown;
  submitted_at: unknown;
  validated_at: unknown;
  updated_at: unknown;
}

const COLS = `id, business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount,
  destination_address, status, policy_version, idempotency_key, request_hash, tx_hash, last_ledger_sequence,
  first_ledger_sequence, ledger_index, result_code, delivered_amount, fee_drops::text AS fee_drops, failure_code,
  failure_message, agent_reason, signed_blob, previous_payment_id, business_date::text AS business_date,
  requested_at, submitted_at, validated_at, updated_at`;

function map(r: PaymentDbRow): PaymentRow {
  const status = PaymentStatusSchema.safeParse(r.status);
  if (!status.success) throw new DbError("DATA_INTEGRITY");
  return {
    ...r,
    status: status.data,
    amount: moneyOut(r.amount),
    delivered_amount: moneyOutOrNull(r.delivered_amount),
    requested_at: iso(r.requested_at),
    submitted_at: isoOrNull(r.submitted_at),
    validated_at: isoOrNull(r.validated_at),
    updated_at: iso(r.updated_at),
  };
}

export interface NewPayment {
  business_id: string;
  invoice_id: string;
  supplier_id: string;
  wallet_id: string;
  network: string;
  asset_currency: string;
  asset_issuer: string;
  amount: MoneyString;
  destination_address: string;
  /** Only `requested` or `blocked` (the database refuses anything else). */
  status: "requested" | "blocked";
  policy_version: number;
  idempotency_key: string;
  request_hash: string;
  failure_code?: string | undefined;
  failure_message?: string | undefined;
  agent_reason?: string | undefined;
  previous_payment_id?: string | undefined;
  business_date: string;
}

export async function insertPayment(q: Queryable, p: NewPayment): Promise<PaymentRow> {
  const row = await runOne<PaymentDbRow>(
    q,
    `INSERT INTO payments (business_id, invoice_id, supplier_id, wallet_id, network, asset_currency, asset_issuer, amount,
        destination_address, status, policy_version, idempotency_key, request_hash, failure_code, failure_message,
        agent_reason, previous_payment_id, business_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${COLS}`,
    [
      uuid(p.business_id), uuid(p.invoice_id), uuid(p.supplier_id), uuid(p.wallet_id), p.network, p.asset_currency,
      p.asset_issuer, moneyIn(p.amount), p.destination_address, p.status, p.policy_version, p.idempotency_key,
      p.request_hash, p.failure_code ?? null, p.failure_message ?? null, p.agent_reason ?? null,
      p.previous_payment_id === undefined ? null : uuid(p.previous_payment_id), p.business_date,
    ],
  );
  if (!row) throw new DbError("DB_ERROR");
  return map(row);
}

export async function getPayment(q: Queryable, id: string): Promise<PaymentRow | null> {
  const r = await runOne<PaymentDbRow>(q, `SELECT ${COLS} FROM payments WHERE id = $1`, [uuid(id)]);
  return r ? map(r) : null;
}

/** Same as getPayment but locks the row for the rest of the transaction. */
export async function getPaymentForUpdate(q: Queryable, id: string): Promise<PaymentRow | null> {
  const r = await runOne<PaymentDbRow>(q, `SELECT ${COLS} FROM payments WHERE id = $1 FOR UPDATE`, [uuid(id)]);
  return r ? map(r) : null;
}

export async function getPaymentByIdempotencyKey(q: Queryable, businessId: string, key: string): Promise<PaymentRow | null> {
  const r = await runOne<PaymentDbRow>(q, `SELECT ${COLS} FROM payments WHERE business_id = $1 AND idempotency_key = $2`, [uuid(businessId), key]);
  return r ? map(r) : null;
}

export async function listPaymentsForInvoice(q: Queryable, invoiceId: string): Promise<PaymentRow[]> {
  const rows = await run<PaymentDbRow>(q, `SELECT ${COLS} FROM payments WHERE invoice_id = $1 ORDER BY requested_at DESC, id LIMIT 100`, [uuid(invoiceId)]);
  return rows.map(map);
}

export interface ListPaymentsFilter {
  businessId?: string | undefined;
  invoiceId?: string | undefined;
  status?: PaymentStatus | undefined;
  /** 1..100, default 25. */
  limit?: number | undefined;
}

export async function listPayments(q: Queryable, f: ListPaymentsFilter): Promise<PaymentRow[]> {
  const limit = f.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DbError("INVALID_INPUT");
  const status = f.status === undefined ? null : PaymentStatusSchema.parse(f.status);
  const rows = await run<PaymentDbRow>(
    q,
    `SELECT ${COLS} FROM payments
      WHERE ($1::uuid IS NULL OR business_id = $1) AND ($2::uuid IS NULL OR invoice_id = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY requested_at DESC, id LIMIT $4`,
    [f.businessId === undefined ? null : uuid(f.businessId), f.invoiceId === undefined ? null : uuid(f.invoiceId), status, limit],
  );
  return rows.map(map);
}

export interface PaymentPatch {
  tx_hash?: string;
  last_ledger_sequence?: number;
  first_ledger_sequence?: number;
  ledger_index?: number;
  result_code?: string;
  delivered_amount?: MoneyString;
  fee_drops?: string;
  failure_code?: string;
  failure_message?: string;
  signed_blob?: string | null;
  submitted_at?: boolean;
  validated_at?: boolean;
}

/**
 * Moves a payment from `from` to `to`. The WHERE clause carries the expected current status, so a concurrent writer
 * (sweeper, reconciler) makes this return null instead of overwriting. The database trigger independently rejects any
 * illegal pair. `signed_blob` is cleared when the new status is final.
 */
export async function transitionPayment(q: Queryable, id: string, from: PaymentStatus, to: PaymentStatus, patch: PaymentPatch = {}): Promise<PaymentRow | null> {
  PaymentStatusSchema.parse(from);
  PaymentStatusSchema.parse(to);
  const final = to === "validated" || to === "failed" || to === "cancelled";
  const blobSet = final ? true : patch.signed_blob !== undefined;
  const r = await runOne<PaymentDbRow>(
    q,
    `UPDATE payments SET
        status = $3,
        tx_hash = COALESCE($4, tx_hash),
        last_ledger_sequence = COALESCE($5, last_ledger_sequence),
        first_ledger_sequence = COALESCE($6, first_ledger_sequence),
        ledger_index = COALESCE($7, ledger_index),
        result_code = COALESCE($8, result_code),
        delivered_amount = COALESCE($9::numeric, delivered_amount),
        fee_drops = COALESCE($10::bigint, fee_drops),
        failure_code = COALESCE($11, failure_code),
        failure_message = COALESCE($12, failure_message),
        signed_blob = CASE WHEN $13::boolean THEN $14 ELSE signed_blob END,
        submitted_at = CASE WHEN $15::boolean THEN now() ELSE submitted_at END,
        validated_at = CASE WHEN $16::boolean THEN now() ELSE validated_at END,
        updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING ${COLS}`,
    [
      uuid(id), from, to, patch.tx_hash ?? null, patch.last_ledger_sequence ?? null, patch.first_ledger_sequence ?? null,
      patch.ledger_index ?? null, patch.result_code ?? null,
      patch.delivered_amount === undefined ? null : moneyIn(patch.delivered_amount, true),
      patch.fee_drops ?? null, patch.failure_code ?? null, patch.failure_message ?? null,
      blobSet, final ? null : (patch.signed_blob ?? null), patch.submitted_at === true, patch.validated_at === true,
    ],
  );
  return r ? map(r) : null;
}

/** Reconciler batch: payments awaiting an outcome, locked with SKIP LOCKED so two reconcilers never overlap. */
export async function lockPaymentsAwaitingOutcome(q: Queryable, limit: number): Promise<PaymentRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DbError("INVALID_INPUT");
  const rows = await run<PaymentDbRow>(
    q,
    `SELECT ${COLS} FROM payments WHERE status IN ('submitted', 'pending_confirmation')
      ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT $1`,
    [limit],
  );
  return rows.map(map);
}

/** Sweeper candidates: reserved/requested with no signing data, older than the timeout. A hashed payment is never returned. */
export async function lockStaleUnsignedPayments(q: Queryable, olderThanSeconds: number, limit: number): Promise<PaymentRow[]> {
  if (!Number.isInteger(olderThanSeconds) || olderThanSeconds < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new DbError("INVALID_INPUT");
  const rows = await run<PaymentDbRow>(
    q,
    `SELECT ${COLS} FROM payments
      WHERE status IN ('requested', 'reserved') AND tx_hash IS NULL AND signed_blob IS NULL
        AND updated_at < now() - make_interval(secs => $1)
      ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT $2`,
    [olderThanSeconds, limit],
  );
  return rows.map(map);
}

/**
 * Cross-process per-wallet SESSION lock (PG-6) for the whole sign-submit-settle section. The caller holds a dedicated
 * client, releases with releaseWalletSessionLock, and destroys the client if the release fails (the lock dies with the session).
 */
export async function acquireWalletSessionLock(q: Queryable, walletId: string): Promise<void> {
  await run(q, "SELECT pg_advisory_lock(hashtextextended('wallet:' || $1::text, 0))", [uuid(walletId)]);
}
export async function releaseWalletSessionLock(q: Queryable, walletId: string): Promise<boolean> {
  const row = await runOne<{ ok: boolean }>(q, "SELECT pg_advisory_unlock(hashtextextended('wallet:' || $1::text, 0)) AS ok", [uuid(walletId)]);
  return row?.ok === true;
}
/** Cross-process per-wallet lock for the signing section, held by the caller's dedicated client until it commits. */
export async function lockWalletForSigning(q: Queryable, walletId: string): Promise<void> {
  await run(q, "SELECT pg_advisory_xact_lock(hashtextextended('wallet:' || $1::text, 0))", [uuid(walletId)]);
}

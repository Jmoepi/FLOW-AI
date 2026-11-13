import type { MoneyString } from "@flow-ai/contracts";
import { Dec, formatMoney } from "@flow-ai/policy-engine";
import { DbError } from "../errors";
import { iso, moneyIn, moneyOut, run, runOne, uuid, type Queryable } from "../db";
import type { ReservationRow, ReservationStatus } from "./types";

interface ReservationDbRow {
  id: string;
  business_id: string;
  business_date: string;
  payment_id: string;
  amount: unknown;
  status: ReservationStatus;
  created_at: unknown;
  updated_at: unknown;
}

const COLS = "id, business_id, business_date::text AS business_date, payment_id, amount, status, created_at, updated_at";
const STATUSES: readonly ReservationStatus[] = ["reserved", "committed", "released"];

function map(r: ReservationDbRow): ReservationRow {
  if (!STATUSES.includes(r.status)) throw new DbError("DATA_INTEGRITY");
  return { ...r, amount: moneyOut(r.amount), created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}

/** Insert is checked by the cap trigger: it raises CHECK_VIOLATION when the daily limit would be exceeded. */
export async function insertReservation(
  q: Queryable,
  r: { business_id: string; business_date: string; payment_id: string; amount: MoneyString },
): Promise<ReservationRow> {
  const row = await runOne<ReservationDbRow>(
    q,
    `INSERT INTO daily_spend_reservations (business_id, business_date, payment_id, amount, status)
     VALUES ($1, $2, $3, $4, 'reserved') RETURNING ${COLS}`,
    [uuid(r.business_id), r.business_date, uuid(r.payment_id), moneyIn(r.amount)],
  );
  if (!row) throw new DbError("DB_ERROR");
  return map(row);
}

export async function getReservationForPayment(q: Queryable, paymentId: string): Promise<ReservationRow | null> {
  const r = await runOne<ReservationDbRow>(q, `SELECT ${COLS} FROM daily_spend_reservations WHERE payment_id = $1`, [uuid(paymentId)]);
  return r ? map(r) : null;
}

export async function listReservationsForDay(q: Queryable, businessId: string, businessDate: string): Promise<ReservationRow[]> {
  const rows = await run<ReservationDbRow>(
    q,
    `SELECT ${COLS} FROM daily_spend_reservations WHERE business_id = $1 AND business_date = $2 ORDER BY created_at, id LIMIT 1000`,
    [uuid(businessId), businessDate],
  );
  return rows.map(map);
}

/** Sum of holds still in `reserved` (in-flight, not yet settled). Used to compute effective balance. */
export async function sumInFlightReserved(q: Queryable, businessId: string): Promise<MoneyString> {
  const rows = await run<{ amount: unknown }>(
    q,
    "SELECT amount FROM daily_spend_reservations WHERE business_id = $1 AND status = 'reserved'",
    [uuid(businessId)],
  );
  let total = new Dec(0);
  for (const r of rows) total = total.plus(new Dec(moneyOut(r.amount)));
  return formatMoney(total);
}

/** reserved -> committed | released. Returns null when the reservation is not in `reserved` any more. */
export async function settleReservation(q: Queryable, paymentId: string, to: "committed" | "released"): Promise<ReservationRow | null> {
  const r = await runOne<ReservationDbRow>(
    q,
    `UPDATE daily_spend_reservations SET status = $2, updated_at = now() WHERE payment_id = $1 AND status = 'reserved' RETURNING ${COLS}`,
    [uuid(paymentId), to],
  );
  return r ? map(r) : null;
}

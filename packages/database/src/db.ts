import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MONEY_STRING_PATTERN, type MoneyString } from "@flow-ai/contracts";
import { Dec, formatMoney, parseMoney } from "@flow-ai/policy-engine";
import { DbError, mapDbError } from "./errors";

/** Anything that can run a query: the pool or a transaction client. */
export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates an identifier BEFORE it reaches any query (IN-1). Returns it lower-cased. */
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new DbError("INVALID_ID");
  return value.toLowerCase();
}

/** Validates an outgoing money string (G-4). No numbers, no exponents, at most 6 decimals. */
export function moneyIn(value: unknown, allowZero = false): MoneyString {
  const d = parseMoney(value, allowZero);
  if (d === null) throw new DbError("INVALID_INPUT");
  return value as MoneyString;
}

/** Normalises a numeric column (returned by pg as a string) into the canonical money string. */
export function moneyOut(value: unknown): MoneyString {
  if (typeof value !== "string") throw new DbError("DATA_INTEGRITY");
  const d = new Dec(value);
  if (!d.isFinite() || d.isNegative()) throw new DbError("DATA_INTEGRITY");
  const out = formatMoney(d);
  if (!MONEY_STRING_PATTERN.test(out)) throw new DbError("DATA_INTEGRITY");
  return out;
}

export function moneyOutOrNull(value: unknown): MoneyString | null {
  return value === null || value === undefined ? null : moneyOut(value);
}

export function iso(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new DbError("DATA_INTEGRITY");
  return value.toISOString();
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** Runs one parameterised statement. Errors are mapped to DbError (no SQL text or parameters leak). */
export async function run<R extends QueryResultRow>(q: Queryable, text: string, values: readonly unknown[] = []): Promise<R[]> {
  try {
    const res = await (q as Pick<Pool, "query">).query<R>(text, values as unknown[]);
    return res.rows;
  } catch (err) {
    throw mapDbError(err);
  }
}

export async function runOne<R extends QueryResultRow>(q: Queryable, text: string, values: readonly unknown[] = []): Promise<R | null> {
  const rows = await run<R>(q, text, values);
  return rows[0] ?? null;
}

/** Database clock (single time source for decisions, 6.4). */
export async function dbNow(q: Queryable): Promise<Date> {
  const row = await runOne<{ now: Date }>(q, "SELECT clock_timestamp() AS now");
  if (!row) throw new DbError("DB_ERROR");
  return row.now;
}

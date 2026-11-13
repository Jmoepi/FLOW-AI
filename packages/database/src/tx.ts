import type { Pool, PoolClient } from "pg";
import { DbError, mapDbError } from "./errors";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Total attempts including the first one when Postgres reports a serialization failure or deadlock. */
  maxAttempts?: number;
}

/**
 * Runs `fn` in a transaction. Commits on success, rolls back on any error. Retries the whole function on
 * 40001/40P01 (max 3 attempts), so `fn` must be safe to re-run (no external side effects inside it).
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  const isolation = options.isolation ?? "READ COMMITTED";
  if (!["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"].includes(isolation)) throw new DbError("INVALID_INPUT");
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 3);
  let lastError: DbError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect().catch((err: unknown) => {
      throw mapDbError(err);
    });
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      const mapped = mapDbError(err);
      if (mapped.code !== "RETRYABLE" || attempt === maxAttempts) {
        // Application errors thrown by fn pass through untouched.
        throw err instanceof DbError || !isDriverError(err) ? err : mapped;
      }
      lastError = mapped;
    } finally {
      client.release();
    }
  }
  throw lastError ?? new DbError("DB_ERROR");
}

function isDriverError(err: unknown): boolean {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" && /^[0-9A-Z]{5}$/.test((err as { code: string }).code);
}

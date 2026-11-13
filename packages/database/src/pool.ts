import pg from "pg";
import { redactError } from "@flow-ai/contracts";

export interface CreatePoolOptions {
  /** Postgres connection string. Never logged. TLS follows its sslmode. */
  connectionString?: string;
  /** Alternative to a connection string (local admin pools). */
  config?: Pick<pg.PoolConfig, "host" | "port" | "user" | "password" | "database">;
  applicationName?: string;
  max?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /** Receives a redacted one-line message when an idle client errors. */
  onError?: (message: string) => void;
}

/**
 * Creates a pool with server-side timeouts so a stuck query or an abandoned transaction cannot hold locks forever.
 * The pool error listener is mandatory: an unhandled 'error' event on an idle client would crash the process.
 */
export function createPool(options: CreatePoolOptions): pg.Pool {
  const base: pg.PoolConfig = options.connectionString !== undefined ? { connectionString: options.connectionString } : { ...options.config };
  const pool = new pg.Pool({
    ...base,
    application_name: options.applicationName ?? "flow-ai",
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    options.onError?.(`pool error: ${redactError(err)}`);
  });
  return pool;
}

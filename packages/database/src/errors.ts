/**
 * Stable database error codes. The message is fixed per code and never contains SQL text, parameters or row data
 * (AL-2/IN-7). The original error is kept only as `cause` for in-process debugging and must not be logged raw.
 */
export type DbErrorCode =
  | "INVALID_ID"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNIQUE_VIOLATION"
  | "CHECK_VIOLATION"
  | "FOREIGN_KEY_VIOLATION"
  | "STATE_VIOLATION"
  | "PERMISSION_DENIED"
  | "RETRYABLE"
  | "DATA_INTEGRITY"
  | "DB_ERROR";

const MESSAGES: Record<DbErrorCode, string> = {
  INVALID_ID: "invalid identifier",
  INVALID_INPUT: "invalid input",
  NOT_FOUND: "record not found",
  UNIQUE_VIOLATION: "unique constraint violated",
  CHECK_VIOLATION: "check constraint violated",
  FOREIGN_KEY_VIOLATION: "foreign key violated",
  STATE_VIOLATION: "illegal state change rejected by the database",
  PERMISSION_DENIED: "permission denied",
  RETRYABLE: "transaction conflict, retry",
  DATA_INTEGRITY: "stored data failed validation",
  DB_ERROR: "database error",
};

export class DbError extends Error {
  readonly code: DbErrorCode;
  /** Name of the violated constraint or index when Postgres reports one (a schema identifier, not data). */
  readonly constraint: string | undefined;
  constructor(code: DbErrorCode, options: { constraint?: string | undefined; cause?: unknown } = {}) {
    super(MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbError";
    this.code = code;
    this.constraint = options.constraint;
  }
}

/** Maps a driver error to a DbError by SQLSTATE. Unknown shapes become DB_ERROR. */
export function mapDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const e = err as { code?: unknown; constraint?: unknown } | null;
  const sqlState = typeof e?.code === "string" ? e.code : "";
  const constraint = typeof e?.constraint === "string" ? e.constraint : undefined;
  const opts = { constraint, cause: err };
  switch (sqlState) {
    case "23505":
      return new DbError("UNIQUE_VIOLATION", opts);
    case "23514":
    case "23502":
    case "22P02":
    case "22003":
      return new DbError("CHECK_VIOLATION", opts);
    case "23503":
      return new DbError("FOREIGN_KEY_VIOLATION", opts);
    case "55000":
      return new DbError("STATE_VIOLATION", opts);
    case "42501":
      return new DbError("PERMISSION_DENIED", opts);
    case "40001":
    case "40P01":
      return new DbError("RETRYABLE", opts);
    default:
      return new DbError("DB_ERROR", opts);
  }
}

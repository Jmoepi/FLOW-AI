import { DbError } from "./errors";
import { runOne, type Queryable } from "./db";
/** Liveness probe for the readiness endpoint. Throws a DbError when the database cannot answer. */
export async function pingDatabase(q: Queryable): Promise<void> {
  const row = await runOne<{ ok: number }>(q, "SELECT 1 AS ok");
  if (row?.ok !== 1) throw new DbError("DB_ERROR");
}
export interface RoleFlags {
  rolsuper: boolean;
  rolbypassrls: boolean;
}
/** Privilege flags of the role this connection runs as. The guard refuses to start if either is true (13.1B). */
export async function getCurrentRoleFlags(q: Queryable): Promise<RoleFlags> {
  const row = await runOne<RoleFlags>(q, "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  if (!row) throw new DbError("DB_ERROR");
  return { rolsuper: row.rolsuper === true, rolbypassrls: row.rolbypassrls === true };
}

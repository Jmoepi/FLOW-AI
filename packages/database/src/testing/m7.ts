import type pg from "pg";
/** Test-only SQL for the M7 signing-key tests (the data-access boundary keeps SQL text inside this package). Never imported by production code. */
export async function walletSigningKeyMode(admin: pg.Pool, walletId: string): Promise<string> {
  const r = await admin.query<{ signing_key_mode: string }>("SELECT signing_key_mode FROM treasury_wallets WHERE id = $1", [walletId]);
  return r.rows[0]?.signing_key_mode as string;
}
/** Runs the UPDATE as the given role's pool. Rejects when the role or the transition trigger refuses it. */
export async function setWalletSigningKeyModeAs(pool: pg.Pool, walletId: string, mode: string): Promise<void> {
  await pool.query("UPDATE treasury_wallets SET signing_key_mode = $2 WHERE id = $1", [walletId, mode]);
}
/** Attempts to change a wallet column other than signing_key_mode as the given pool. Only a fixed set of columns is accepted. */
export async function attemptWalletColumnUpdate(pool: pg.Pool, walletId: string, column: "address" | "is_active"): Promise<void> {
  const sql = column === "address" ? "UPDATE treasury_wallets SET address = address WHERE id = $1" : "UPDATE treasury_wallets SET is_active = false WHERE id = $1";
  await pool.query(sql, [walletId]);
}
export async function attemptWalletModeUpdateAll(pool: pg.Pool, mode: string): Promise<void> {
  await pool.query("UPDATE treasury_wallets SET signing_key_mode = $1", [mode]);
}
export async function latestRegularKeyState(admin: pg.Pool, walletId: string): Promise<string | null | undefined> {
  const r = await admin.query<{ regular_key_state: string | null }>("SELECT regular_key_state FROM balance_snapshots WHERE wallet_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1", [walletId]);
  return r.rows[0]?.regular_key_state;
}
export async function maxLastLedgerSequence(admin: pg.Pool, walletId: string): Promise<number> {
  const r = await admin.query<{ lls: number }>("SELECT max(last_ledger_sequence) AS lls FROM payments WHERE wallet_id = $1", [walletId]);
  return r.rows[0]?.lls as number;
}
export async function auditEventTypesForBusiness(admin: pg.Pool, businessId: string): Promise<string[]> {
  const r = await admin.query<{ event_type: string }>("SELECT event_type FROM audit_events WHERE business_id = $1 ORDER BY seq", [businessId]);
  return r.rows.map((x) => x.event_type);
}

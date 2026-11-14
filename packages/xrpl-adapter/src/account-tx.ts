import type { SubmittableTransaction, Wallet } from "xrpl";
import type { LedgerGateway } from "./gateway";

/**
 * Validated-result submit for account-management transactions (owner scripts, M7). Same rules as the payment flow:
 * only a VALIDATED ledger result counts. A preliminary engine result (tes*, ter*, tel*, tef*) is never reported as success.
 */
export interface AccountTxGateway extends LedgerGateway {
  autofillTx(tx: SubmittableTransaction): Promise<SubmittableTransaction>;
}

export type AccountTxOutcome =
  | { kind: "validated_success"; hash: string; ledgerIndex: number; resultCode: string }
  | { kind: "validated_failed"; hash: string; ledgerIndex: number; resultCode: string }
  /** The server refused it at submit and it can no longer validate (tef or tem codes): nothing is in the ledger. */
  | { kind: "rejected"; hash: string; engineResult: string }
  | { kind: "failed_expired"; hash: string; validatedLedgerIndex: number }
  | { kind: "pending"; hash: string; reason: string };

export interface AccountTxOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FINAL_REJECTION = /^(tef|tem)[A-Za-z_]+$/;

/** Signs with the given wallet, submits once, then polls by hash. Never resubmits under a new sequence. */
export async function submitAccountTxAndWait(gw: AccountTxGateway, wallet: Wallet, tx: SubmittableTransaction, opts: AccountTxOptions = {}): Promise<AccountTxOutcome> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const interval = opts.pollIntervalMs ?? 2000;
  const deadline = now() + (opts.timeoutMs ?? 90_000);
  const info = await gw.getNetworkInfo();
  if (info.networkId !== 1) throw new Error(`Refusing to submit: server network_id is ${String(info.networkId)}, expected 1 (Testnet).`);
  const prepared = await gw.autofillTx(tx);
  const first = await gw.getValidatedLedgerIndex();
  if (prepared.LastLedgerSequence === undefined) prepared.LastLedgerSequence = first + 20;
  const lls = prepared.LastLedgerSequence;
  const signed = wallet.sign(prepared);
  const hash = signed.hash;
  try {
    const ack = await gw.submitBlob(signed.tx_blob);
    if (FINAL_REJECTION.test(ack.engineResult)) return { kind: "rejected", hash, engineResult: ack.engineResult };
  } catch {
    // Uncertain: the submit may have reached the network. Keep polling by hash.
  }
  let reason = "waiting";
  while (now() < deadline) {
    await sleep(interval);
    try {
      const validated = await gw.getValidatedLedgerIndex();
      const range = validated >= first ? { minLedger: first, maxLedger: validated } : undefined;
      const found = await gw.lookupTx(hash, range);
      if (found.status === "found") {
        if (found.validated && found.resultCode !== undefined && found.ledgerIndex !== undefined) {
          return found.resultCode === "tesSUCCESS"
            ? { kind: "validated_success", hash, ledgerIndex: found.ledgerIndex, resultCode: found.resultCode }
            : { kind: "validated_failed", hash, ledgerIndex: found.ledgerIndex, resultCode: found.resultCode };
        }
        reason = "found but not yet validated";
      } else if (validated > lls && found.searchedAll === true) {
        return { kind: "failed_expired", hash, validatedLedgerIndex: validated };
      } else reason = "not found yet";
    } catch {
      reason = "lookup error";
    }
  }
  return { kind: "pending", hash, reason };
}

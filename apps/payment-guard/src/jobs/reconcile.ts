import { redactError } from "@flow-ai/contracts";
import { lockPaymentsAwaitingOutcome, withTransaction, type PaymentRow } from "@flow-ai/database";
import { reconcilePayment, submitAndWait, type PaymentOutcome, type WaitOptions } from "@flow-ai/xrpl-adapter";
import { applyOutcomeIn, SYSTEM_ACTOR } from "../services/apply-outcome";
import type { ServiceDeps } from "../services/payments";
import { createLoop } from "./loop";

export interface ReconcileCounts {
  checked: number;
  validated: number;
  failed: number;
  pending: number;
  resubmitted: number;
}
export interface Reconciler {
  runOnce(): Promise<ReconcileCounts>;
  start(): void;
  stop(): Promise<void>;
}

const MAX_PER_RUN = 20;
const RESUBMIT_TIMEOUT_MS = 4000; // keeps the per-payment transaction well under the idle-in-transaction timeout

/**
 * Finds the outcome of one payment. Never returns failed_expired unless the adapter proved complete history (F-19).
 * The stored, identical blob is resubmitted only while LastLedgerSequence is still in the future: never re-signed,
 * never a new Sequence.
 */
export async function reconcileOne(
  deps: Pick<ServiceDeps, "gateway">, p: PaymentRow, wait: WaitOptions = { timeoutMs: RESUBMIT_TIMEOUT_MS, pollIntervalMs: 1000 },
): Promise<{ outcome: PaymentOutcome; resubmitted: boolean } | null> {
  if (p.tx_hash === null || p.last_ledger_sequence === null) return null;
  const expected = { currency: p.asset_currency, issuer: p.asset_issuer, value: p.amount };
  const ref = { hash: p.tx_hash, lastLedgerSequence: p.last_ledger_sequence, firstLedgerSequence: p.first_ledger_sequence ?? undefined };
  const outcome = await reconcilePayment(deps.gateway, ref, expected);
  if (outcome.kind === "pending" && !outcome.seenOnLedger && outcome.validatedLedgerIndex < p.last_ledger_sequence && p.signed_blob !== null) {
    const again = await submitAndWait(deps.gateway, { ...ref, txBlob: p.signed_blob, amount: expected }, wait);
    return { outcome: again, resubmitted: true };
  }
  return { outcome, resubmitted: false };
}

export function createReconciler(deps: ServiceDeps): Reconciler {
  let current: Promise<ReconcileCounts> | undefined;

  async function run(): Promise<ReconcileCounts> {
    const counts: ReconcileCounts = { checked: 0, validated: 0, failed: 0, pending: 0, resubmitted: 0 };
    const seen = new Set<string>();
    for (let i = 0; i < MAX_PER_RUN; i++) {
      // One payment per transaction: the row lock (SKIP LOCKED) is held only for that payment's network round trips.
      const step = await withTransaction(deps.pool, async (c) => {
        // Ask for one more row than already handled, so a payment whose lookup failed cannot starve the ones behind it.
        const p = (await lockPaymentsAwaitingOutcome(c, Math.min(seen.size + 1, 100))).find((r) => !seen.has(r.id));
        if (!p) return "done" as const;
        seen.add(p.id);
        let found: Awaited<ReturnType<typeof reconcileOne>> = null;
        try {
          found = await reconcileOne(deps, p);
        } catch (err) {
          deps.logger.warn("reconcile.lookup_failed", { payment_id: p.id, error: redactError(err) });
        }
        counts.checked++;
        if (!found) return "next" as const;
        if (found.resubmitted) counts.resubmitted++;
        const row = await applyOutcomeIn(c, p.id, found.outcome, SYSTEM_ACTOR);
        if (row?.status === "validated") counts.validated++;
        else if (row?.status === "failed") counts.failed++;
        else counts.pending++;
        return "next" as const;
      }, { maxAttempts: 1 });
      if (step === "done") break;
    }
    return counts;
  }

  const runOnce = (): Promise<ReconcileCounts> => {
    // Overlap guard: a second caller (timer or HTTP) joins the run that is already going.
    current ??= run().finally(() => {
      current = undefined;
    });
    return current;
  };
  const loop = createLoop("reconcile", deps.config.reconcileIntervalSeconds * 1000, runOnce, deps.logger);
  return { runOnce, start: () => loop.start(), stop: () => loop.stop() };
}

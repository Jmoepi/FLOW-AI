import { lockStaleUnsignedPayments, withTransaction } from "@flow-ai/database";
import { cancelUnsignedIn, SYSTEM_ACTOR } from "../services/apply-outcome";
import type { ServiceDeps } from "../services/payments";
import { createLoop, type Loop } from "./loop";

/**
 * Cancels reservations that never reached signing (5A.2). Selection requires tx_hash IS NULL and signed_blob IS NULL, and
 * the cancel helper re-checks both under the row lock, so a payment with a persisted hash is never cancelled here.
 */
export async function sweepStaleReservations(deps: ServiceDeps): Promise<number> {
  return withTransaction(deps.pool, async (c) => {
    const stale = await lockStaleUnsignedPayments(c, deps.config.staleReservationTimeoutSeconds, 50);
    let cancelled = 0;
    for (const p of stale) {
      const row = await cancelUnsignedIn(c, p.id, "STALE_RESERVATION", "Reservation expired before signing.", SYSTEM_ACTOR);
      if (row) cancelled++;
    }
    if (cancelled > 0) deps.logger.info("sweeper.cancelled", { count: cancelled });
    return cancelled;
  });
}

export function createSweeper(deps: ServiceDeps): Loop {
  const everyMs = Math.min(60, Math.max(10, Math.floor(deps.config.staleReservationTimeoutSeconds / 4))) * 1000;
  return createLoop("sweeper", everyMs, () => sweepStaleReservations(deps), deps.logger);
}

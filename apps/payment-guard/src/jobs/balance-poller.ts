import { redactError } from "@flow-ai/contracts";
import { insertSnapshot, listActiveWallets } from "@flow-ai/database";
import { Dec, formatMoney, parseMoney } from "@flow-ai/policy-engine";
import { regularKeyAddress } from "../signer/signer";
import type { ServiceDeps } from "../services/payments";
import { classifyRegularKey } from "../state/signing-key";
import { createLoop, type Loop } from "./loop";

/** Integer drops to an exact XRP decimal string using BigInt only (G-4). */
export function dropsToXrp(drops: string): string | null {
  if (!/^\d{1,18}$/.test(drops)) return null;
  const n = BigInt(drops);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Ledger IOU balances can carry more than 6 decimals: round DOWN to the stored precision so a snapshot never overstates funds. */
export function storableBalance(value: string | null): string | null {
  if (value === null) return null;
  try {
    const d = new Dec(value);
    if (!d.isFinite() || d.isNegative()) return null;
    const out = formatMoney(d.toDecimalPlaces(6, Dec.ROUND_DOWN));
    return parseMoney(out, true) === null ? null : out;
  } catch {
    return null;
  }
}

/** One pass over the active wallets. Returns how many snapshots were written. Errors are logged redacted and skipped. */
export async function pollBalances(deps: ServiceDeps): Promise<number> {
  const { pool, gateway, config, logger } = deps;
  let written = 0;
  for (const wallet of await listActiveWallets(pool)) {
    if (wallet.network !== config.network || (config.businessId !== undefined && wallet.business_id !== config.businessId)) continue;
    try {
      const snap = await gateway.getAccountSnapshot(wallet.address, config.rlusd.issuer, config.rlusd.currencyHex);
      const xrp = dropsToXrp(snap.xrpDrops);
      if (xrp === null) throw new Error("unexpected XRP balance format");
      // Read-only observation of the ledger RegularKey against the configured guard key ADDRESS (public). Informational.
      const configured = regularKeyAddress(deps.env());
      const regular_key_state = deps.signingKey
        ? await deps.signingKey.observe(wallet, { regularKey: snap.regularKey, configuredAddress: configured, ledgerIndex: snap.ledgerIndex })
        : classifyRegularKey(snap.regularKey, configured);
      await insertSnapshot(pool, { wallet_id: wallet.id, rlusd_balance: storableBalance(snap.rlusdBalance), xrp_balance: xrp, ledger_index: snap.ledgerIndex, regular_key_state });
      written++;
    } catch (err) {
      logger.warn("balance_poll.failed", { wallet_id: wallet.id, error: redactError(err) });
    }
  }
  return written;
}

export function createBalancePoller(deps: ServiceDeps): Loop {
  return createLoop("balance-poller", deps.config.balancePollIntervalSeconds * 1000, () => pollBalances(deps), deps.logger);
}

/** The one place that decides whether a transaction hash may become a link (IN-5). */
const TX_HASH = /^[0-9A-F]{64}$/;
export const EXPLORER_PREFIX = "https://testnet.xrpl.org/transactions/";
export const isTxHash = (value: unknown): value is string => typeof value === "string" && TX_HASH.test(value);
/** A link exists only for a validated payment with a canonical 64 upper-case hex hash; the origin is fixed. */
export function explorerUrl(status: string | null, txHash: string | null): string | null {
  return status === "validated" && isTxHash(txHash) ? `${EXPLORER_PREFIX}${txHash}` : null;
}

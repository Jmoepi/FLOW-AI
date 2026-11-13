import { Wallet, type Payment } from "xrpl";
import { issuedAmountsEqual, type IssuedAmount, type Signer } from "@flow-ai/xrpl-adapter";

/**
 * The ONLY module that knows the signer seed variable (SV-5, 10.8). A source-scan test fails if the name appears in any
 * other file under apps/ or packages/. The seed is read lazily at sign time, used inside one call and never stored.
 */
const SEED_VARIABLE = "XRPL_DEMO_SIGNER_SEED";

export type SignerErrorCode = "EXECUTION_DISABLED" | "NETWORK_REFUSED" | "SEED_UNAVAILABLE" | "ACCOUNT_MISMATCH" | "TX_REFUSED";

/** Errors carry a fixed code and message only: never the seed, the transaction or any value from the environment. */
export class SignerError extends Error {
  readonly code: SignerErrorCode;
  constructor(code: SignerErrorCode) {
    super(code);
    this.name = "SignerError";
    this.code = code;
  }
}

/** What the database says this payment is. The signer signs exactly this and nothing else. */
export interface SigningInstruction {
  account: string;
  destination: string;
  currency: string;
  issuer: string;
  value: string;
}

export interface SignerDeps {
  env: () => NodeJS.ProcessEnv;
  /** Kill switch, re-evaluated on every sign call (13.1C). */
  isExecutionEnabled: () => boolean;
  network: string;
}

// Anything outside this list (Memos, Signers, SigningPubKey, SendMax, DeliverMin, Paths, DestinationTag, ...) is refused.
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["TransactionType", "Account", "Destination", "Amount", "Fee", "Sequence", "LastLedgerSequence", "Flags", "NetworkID"]);
const MAX_FEE_DROPS = 1_000_000n; // 1 XRP: far above any normal fee, far below anything damaging

function assertMatchesInstruction(tx: Payment, instruction: SigningInstruction): void {
  const record = tx as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!ALLOWED_FIELDS.has(key) && record[key] !== undefined) throw new SignerError("TX_REFUSED");
  if (tx.TransactionType !== "Payment" || tx.Account !== instruction.account || tx.Destination !== instruction.destination) throw new SignerError("TX_REFUSED");
  if (tx.Flags !== undefined && tx.Flags !== 0) throw new SignerError("TX_REFUSED");
  const amount: unknown = tx.Amount;
  if (typeof amount !== "object" || amount === null || Object.keys(amount).sort().join(",") !== "currency,issuer,value") throw new SignerError("TX_REFUSED");
  const expected: IssuedAmount = { currency: instruction.currency, issuer: instruction.issuer, value: instruction.value };
  if (!issuedAmountsEqual(amount, expected)) throw new SignerError("TX_REFUSED");
  const fee = tx.Fee;
  if (typeof fee !== "string" || !/^\d{1,7}$/.test(fee) || BigInt(fee) > MAX_FEE_DROPS) throw new SignerError("TX_REFUSED");
}

/**
 * Builds the adapter Signer for ONE reserved payment. The returned object holds the instruction and callbacks, never a
 * key: String(), JSON.stringify and util.inspect on it cannot reveal the seed.
 */
export function createGuardSigner(instruction: SigningInstruction, deps: SignerDeps): Signer {
  const snapshot: SigningInstruction = Object.freeze({ ...instruction });
  return {
    address: snapshot.account,
    sign: (tx: Payment) => {
      // Order matters: every refusal that does not need the seed happens before the seed is touched.
      if (deps.network !== "xrpl-testnet") throw new SignerError("NETWORK_REFUSED");
      if (deps.env().PAYMENT_EXECUTION_ENABLED !== "true" || !deps.isExecutionEnabled()) throw new SignerError("EXECUTION_DISABLED");
      assertMatchesInstruction(tx, snapshot);
      const seed = deps.env()[SEED_VARIABLE];
      if (typeof seed !== "string" || seed === "") throw new SignerError("SEED_UNAVAILABLE");
      let wallet: Wallet;
      try {
        wallet = Wallet.fromSeed(seed);
      } catch {
        throw new SignerError("SEED_UNAVAILABLE"); // never chain the cause: it could echo the seed
      }
      if (wallet.address !== snapshot.account) throw new SignerError("ACCOUNT_MISMATCH");
      try {
        const signed = wallet.sign(tx);
        return { txBlob: signed.tx_blob, hash: signed.hash };
      } catch {
        throw new SignerError("TX_REFUSED");
      }
    },
  };
}

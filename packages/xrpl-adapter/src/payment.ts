import { redactError } from "@flow-ai/contracts";
import { Wallet, type Payment } from "xrpl";
import { issuedAmountsEqual, parseAmount, type IssuedAmount } from "./amount";
import { isGuardLedgerGateway, rangesCover, type LedgerGateway, type SubmitAck } from "./gateway";
import { walletQueue, type KeyedQueue } from "./queue";

/** Spec 10.3: the payment flow. prepare/autofill -> sign -> persist -> submit -> wait -> reconcile. */

const TF_PARTIAL_PAYMENT = 0x00020000;
const DEFAULT_LEDGER_WINDOW = 20; // about 1-2 minutes on Testnet
const MAX_LEDGER_WINDOW = 40;

/**
 * Submit results that mean "the signing key is not authorised for this account" (M7, 19.2 resolved).
 * Verified on Testnet: a blob signed by a REVOKED regular key is refused at submit with tefBAD_AUTH
 * ("Transaction's public key is not authorized.") and never reaches a ledger. Only codes proven by experiment belong here.
 */
export const SIGNING_KEY_REJECTION_CODES: readonly string[] = ["tefBAD_AUTH"];

export interface Signer {
  address: string;
  /** Signs a prepared transaction. The hash is known here, before any submit. */
  sign(tx: Payment): { txBlob: string; hash: string };
}

/** Env-seed signer backend (10.8). The seed never leaves this closure. */
export function walletSigner(wallet: Wallet): Signer {
  return {
    address: wallet.address,
    sign: (tx) => {
      const { tx_blob, hash } = wallet.sign(tx);
      return { txBlob: tx_blob, hash };
    },
  };
}

export interface SignedPayment {
  hash: string;
  txBlob: string;
  lastLedgerSequence: number;
  /** Validated ledger index read just before signing; the lower bound for later history searches. */
  firstLedgerSequence: number;
  sequence: number;
  feeDrops: string;
  account: string;
  destination: string;
  amount: IssuedAmount;
}

export type PaymentOutcome =
  /** Validated, tesSUCCESS and delivered_amount equals the intended amount. The only "paid" state. */
  | { kind: "validated_success"; hash: string; ledgerIndex: number; resultCode: string; deliveredAmount: unknown; feeDrops?: string | undefined }
  /** Validated tec*: in the ledger but failed; the fee was burned. */
  | { kind: "validated_failed"; hash: string; ledgerIndex: number; resultCode: string; feeDrops?: string | undefined }
  /** Validated tesSUCCESS but delivered_amount differs from the intended amount (PARTIAL_DELIVERY). Never "paid". */
  | { kind: "partial_delivery"; hash: string; ledgerIndex: number; resultCode: string; deliveredAmount: unknown; feeDrops?: string | undefined }
  /** Uncertain: keep PENDING_CONFIRMATION and reconcile later. Never resubmit under a new sequence. */
  | { kind: "pending"; hash: string; lastLedgerSequence: number; validatedLedgerIndex: number; seenOnLedger: boolean; reason: string }
  /** The server refused the signature at submit (revoked or wrong regular key). Nothing is in any ledger and nothing can validate. */
  | { kind: "rejected_authorization"; hash: string; engineResult: string }
  /** Definitive: a validated ledger beyond LastLedgerSequence exists and the tx is in no validated ledger. */
  | { kind: "failed_expired"; hash: string; lastLedgerSequence: number; validatedLedgerIndex: number };

export type PaymentEvent =
  | { type: "prepared"; sequence: number; lastLedgerSequence: number; feeDrops: string }
  | { type: "signed"; hash: string }
  | { type: "already_resolved"; outcome: PaymentOutcome }
  | { type: "submit_skipped"; reason: string }
  | { type: "submitted"; ack: SubmitAck }
  | { type: "submit_error"; message: string }
  | { type: "poll"; outcome: PaymentOutcome }
  | { type: "outcome"; outcome: PaymentOutcome };

export function isFinalOutcome(o: PaymentOutcome): boolean {
  return o.kind !== "pending";
}

/** Classifies a validated transaction. Exported for tests. */
export function classifyValidated(
  hash: string,
  ledgerIndex: number,
  resultCode: string,
  deliveredAmount: unknown,
  feeDrops: string | undefined,
  expected: IssuedAmount,
): PaymentOutcome {
  if (resultCode === "tesSUCCESS") {
    return issuedAmountsEqual(deliveredAmount, expected)
      ? { kind: "validated_success", hash, ledgerIndex, resultCode, deliveredAmount, feeDrops }
      : { kind: "partial_delivery", hash, ledgerIndex, resultCode, deliveredAmount, feeDrops };
  }
  // Only tes* and tec* can appear in a validated ledger. Anything else is treated as failed, never as paid.
  return { kind: "validated_failed", hash, ledgerIndex, resultCode, feeDrops };
}

/**
 * Reconcile by hash (10.3 step 12). Reads the validated index BEFORE the tx lookup so that "not found" is
 * only declared definitive for ledgers the lookup could already see.
 */
export async function reconcilePayment(
  gw: LedgerGateway,
  ref: { hash: string; lastLedgerSequence: number; firstLedgerSequence?: number | undefined },
  expected: IssuedAmount,
): Promise<PaymentOutcome> {
  const validatedLedgerIndex = await gw.getValidatedLedgerIndex();
  const first = ref.firstLedgerSequence;
  const range = first !== undefined && Number.isSafeInteger(first) && first >= 1 && first <= validatedLedgerIndex ? { minLedger: first, maxLedger: validatedLedgerIndex } : undefined;
  const tx = await gw.lookupTx(ref.hash, range);
  if (tx.status === "found") {
    if (tx.validated && tx.resultCode && tx.ledgerIndex !== undefined) {
      return classifyValidated(ref.hash, tx.ledgerIndex, tx.resultCode, tx.deliveredAmount, tx.feeDrops, expected);
    }
    return { kind: "pending", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex, seenOnLedger: true, reason: "found but not yet in a validated ledger" };
  }
  if (validatedLedgerIndex > ref.lastLedgerSequence) {
    // F-19 / PG-4: "not found" is only proof of absence when the searched history is provably complete.
    let proven = tx.searchedAll === true; // XrplGateway only reports this for a ranged lookup
    if (!proven && range !== undefined && isGuardLedgerGateway(gw)) {
      try {
        proven = rangesCover(await gw.getCompleteLedgers(), range.minLedger, ref.lastLedgerSequence + 1);
      } catch {
        proven = false; // cannot prove: fail closed
      }
    }
    if (proven) return { kind: "failed_expired", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex };
    return { kind: "pending", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex, seenOnLedger: false, reason: "history incomplete (cannot prove not found)" };
  }
  return { kind: "pending", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex, seenOnLedger: false, reason: "not found yet; LastLedgerSequence still in the future" };
}

export interface WaitOptions {
  pollIntervalMs?: number;
  /** Stop waiting (outcome stays pending) after this long. Default 120 s. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onEvent?: (e: PaymentEvent) => void | Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Idempotent submit-and-wait for an already signed payment. State is checked FIRST using the persisted hash:
 * if the tx is already validated (or definitively expired) nothing is submitted, so re-running with the same
 * blob can never double pay. Resubmitting the identical blob is only done while LastLedgerSequence is in the future.
 */
export async function submitAndWait(
  gw: LedgerGateway,
  signed: Pick<SignedPayment, "hash" | "txBlob" | "lastLedgerSequence" | "amount"> & { firstLedgerSequence?: number | undefined },
  opts: WaitOptions = {},
): Promise<PaymentOutcome> {
  const emit = async (e: PaymentEvent) => {
    await opts.onEvent?.(e);
  };
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const interval = opts.pollIntervalMs ?? 2000;
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const ref = { hash: signed.hash, lastLedgerSequence: signed.lastLedgerSequence, firstLedgerSequence: signed.firstLedgerSequence };

  const first = await reconcilePayment(gw, ref, signed.amount);
  if (isFinalOutcome(first)) {
    await emit({ type: "already_resolved", outcome: first });
    await emit({ type: "outcome", outcome: first });
    return first;
  }
  if (first.kind === "pending" && first.seenOnLedger) {
    await emit({ type: "submit_skipped", reason: "transaction already known to the server" });
  } else {
    try {
      const ack = await gw.submitBlob(signed.txBlob);
      await emit({ type: "submitted", ack });
      if (SIGNING_KEY_REJECTION_CODES.includes(ack.engineResult)) {
        // The signature itself is refused: this blob can never validate. Final, never retried or re-signed here.
        const rejected: PaymentOutcome = { kind: "rejected_authorization", hash: signed.hash, engineResult: ack.engineResult };
        await emit({ type: "outcome", outcome: rejected });
        return rejected;
      }
    } catch (err) {
      // The submit may or may not have reached the network: treat as uncertain and keep polling by hash.
      await emit({ type: "submit_error", message: redactError(err) });
    }
  }

  let last: PaymentOutcome = first;
  while (now() < deadline) {
    await sleep(interval);
    try {
      last = await reconcilePayment(gw, ref, signed.amount);
    } catch {
      continue; // transient lookup error: still uncertain
    }
    await emit({ type: "poll", outcome: last });
    if (isFinalOutcome(last)) break;
  }
  await emit({ type: "outcome", outcome: last });
  return last;
}

export interface SendPaymentParams {
  gateway: LedgerGateway;
  signer: Signer;
  destination: string;
  currency: string;
  issuer: string;
  /** Exact decimal string. */
  value: string;
  /** Called after signing and BEFORE submit. If it throws, nothing is submitted. Persist hash + LastLedgerSequence here. */
  onSigned: (signed: SignedPayment) => void | Promise<void>;
  /** Skip submit entirely (dry run). Returns the signed payment with no outcome. */
  dryRun?: boolean;
  ledgerWindow?: number;
  queue?: KeyedQueue;
  wait?: WaitOptions;
}

export interface SendPaymentResult {
  signed: SignedPayment;
  /** undefined for dry runs. */
  outcome?: PaymentOutcome;
}

/** Builds, autofills and signs (no submit). Exported so callers can persist before submitting. */
export async function prepareAndSign(p: Omit<SendPaymentParams, "onSigned" | "dryRun" | "queue" | "wait">): Promise<SignedPayment> {
  const value = parseAmount(p.value);
  const amount: IssuedAmount = { currency: p.currency.toUpperCase(), issuer: p.issuer, value };
  // No Flags: tfPartialPayment must never be set. No SendMax or DeliverMin either.
  const tx: Payment = { TransactionType: "Payment", Account: p.signer.address, Destination: p.destination, Amount: amount };
  const prepared = await p.gateway.autofill(tx);

  if (((Number(prepared.Flags) || 0) & TF_PARTIAL_PAYMENT) !== 0 || prepared.SendMax !== undefined || prepared.DeliverMin !== undefined) {
    throw new Error("Refusing to sign: payment must not use tfPartialPayment, SendMax or DeliverMin");
  }
  const window = p.ledgerWindow ?? DEFAULT_LEDGER_WINDOW;
  if (window < 1 || window > MAX_LEDGER_WINDOW) throw new Error(`ledgerWindow must be 1..${MAX_LEDGER_WINDOW}`);
  const validated = await p.gateway.getValidatedLedgerIndex();
  if (prepared.LastLedgerSequence === undefined) prepared.LastLedgerSequence = validated + window;
  const lls = prepared.LastLedgerSequence;
  if (lls <= validated || lls - validated > MAX_LEDGER_WINDOW + 5) {
    throw new Error(`Unsafe LastLedgerSequence ${lls} (validated ledger ${validated})`);
  }
  if (prepared.Sequence === undefined || prepared.Fee === undefined) throw new Error("Autofill did not set Sequence and Fee");

  const { txBlob, hash } = p.signer.sign(prepared);
  return {
    hash,
    txBlob,
    lastLedgerSequence: lls,
    firstLedgerSequence: validated,
    sequence: prepared.Sequence,
    feeDrops: prepared.Fee,
    account: p.signer.address,
    destination: p.destination,
    amount,
  };
}

/**
 * The full 10.3 flow for one IOU payment, serialised per sending wallet. The wallet lock is held until the
 * payment reaches a final outcome (or the wait times out) so the next send cannot reuse a Sequence that is still in flight.
 */
export function sendIouPayment(p: SendPaymentParams): Promise<SendPaymentResult> {
  const queue = p.queue ?? walletQueue;
  return queue.run(p.signer.address, async () => {
    const info = await p.gateway.getNetworkInfo();
    if (info.networkId !== 1) throw new Error(`Refusing to send: server network_id is ${String(info.networkId)}, expected 1 (Testnet).`);

    const signed = await prepareAndSign(p);
    await p.wait?.onEvent?.({ type: "prepared", sequence: signed.sequence, lastLedgerSequence: signed.lastLedgerSequence, feeDrops: signed.feeDrops });
    await p.onSigned(signed); // persist hash + LastLedgerSequence (+ blob) before anything touches the network
    await p.wait?.onEvent?.({ type: "signed", hash: signed.hash });
    if (p.dryRun) return { signed };
    const outcome = await submitAndWait(p.gateway, signed, p.wait);
    return { signed, outcome };
  });
}

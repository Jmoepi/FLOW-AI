import { redactError } from "@flow-ai/contracts";
import { Wallet, type Payment } from "xrpl";
import { issuedAmountsEqual, parseAmount, type IssuedAmount } from "./amount";
import type { LedgerGateway, SubmitAck } from "./gateway";
import { walletQueue, type KeyedQueue } from "./queue";

/** Spec 10.3: the payment flow. prepare/autofill -> sign -> persist -> submit -> wait -> reconcile. */

const TF_PARTIAL_PAYMENT = 0x00020000;
const DEFAULT_LEDGER_WINDOW = 20; // about 1-2 minutes on Testnet
const MAX_LEDGER_WINDOW = 40;

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
  ref: { hash: string; lastLedgerSequence: number },
  expected: IssuedAmount,
): Promise<PaymentOutcome> {
  const validatedLedgerIndex = await gw.getValidatedLedgerIndex();
  const tx = await gw.lookupTx(ref.hash);
  if (tx.status === "found") {
    if (tx.validated && tx.resultCode && tx.ledgerIndex !== undefined) {
      return classifyValidated(ref.hash, tx.ledgerIndex, tx.resultCode, tx.deliveredAmount, tx.feeDrops, expected);
    }
    return { kind: "pending", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex, seenOnLedger: true, reason: "found but not yet in a validated ledger" };
  }
  if (validatedLedgerIndex > ref.lastLedgerSequence) {
    return { kind: "failed_expired", hash: ref.hash, lastLedgerSequence: ref.lastLedgerSequence, validatedLedgerIndex };
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
  signed: Pick<SignedPayment, "hash" | "txBlob" | "lastLedgerSequence" | "amount">,
  opts: WaitOptions = {},
): Promise<PaymentOutcome> {
  const emit = async (e: PaymentEvent) => {
    await opts.onEvent?.(e);
  };
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const interval = opts.pollIntervalMs ?? 2000;
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const ref = { hash: signed.hash, lastLedgerSequence: signed.lastLedgerSequence };

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

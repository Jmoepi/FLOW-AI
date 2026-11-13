import { redactError } from "@flow-ai/contracts";
import {
  acquireWalletSessionLock, appendAudit, getPayment, getWallet, releaseWalletSessionLock, transitionPayment, withTransaction,
  type PaymentRow,
} from "@flow-ai/database";
import { KeyedQueue, sendIouPayment, type PaymentEvent } from "@flow-ai/xrpl-adapter";
import { createGuardSigner, SignerError } from "../signer/signer";
import { isInFlight } from "../state/payment-machine";
import { applyOutcome, cancelUnsigned, GUARD_ACTOR } from "./apply-outcome";
import { toPublicPayment, type PaymentResult, type ServiceDeps } from "./payments";

/** Runs one reserved payment through sign -> persist -> submit -> wait -> settle. */
export interface PaymentExecutor {
  execute(paymentId: string): Promise<PaymentRow | null>;
  /** Resolves when no execution is in flight (graceful shutdown). */
  idle(): Promise<void>;
}

const CANCEL_MESSAGES: Record<string, string> = {
  EXECUTION_DISABLED: "Payment execution is disabled.",
  RECORD_INACTIVE: "The treasury wallet is not available for signing.",
};

async function safeAudit(deps: ServiceDeps, paymentId: string, businessId: string, event: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await withTransaction(deps.pool, (c) =>
      appendAudit(c, { business_id: businessId, actor_type: GUARD_ACTOR.type, actor_id: GUARD_ACTOR.id, event_type: event, entity_type: "payment", entity_id: paymentId, metadata }),
    );
  } catch (err) {
    deps.logger.error("payment.audit_failed", { payment_id: paymentId, event, error: redactError(err) });
  }
}

export function createExecutor(deps: ServiceDeps): PaymentExecutor {
  // Same-process serialisation by wallet. The advisory lock below covers other processes (PG-6); the adapter's
  // walletQueue still guards the Sequence inside sendIouPayment. Only one dedicated client is held per wallet here.
  const queue = new KeyedQueue();
  const running = new Set<Promise<unknown>>();

  async function runLocked(paymentId: string, walletId: string): Promise<PaymentRow | null> {
    const { pool, config } = deps;
    const p = await getPayment(pool, paymentId);
    if (!p || p.status !== "reserved") return p; // re-read inside the lock: someone else (sweeper) may have moved it
    const wallet = await getWallet(pool, walletId);
    if (!wallet || !wallet.is_active || wallet.signing_key_mode !== "master_env" || wallet.network !== config.network || p.network !== config.network) {
      return (await cancelUnsigned(pool, p.id, "RECORD_INACTIVE", CANCEL_MESSAGES.RECORD_INACTIVE ?? "", GUARD_ACTOR)) ?? (await getPayment(pool, p.id));
    }
    const enabled = (): boolean => deps.env().PAYMENT_EXECUTION_ENABLED === "true";
    if (!enabled()) {
      return (await cancelUnsigned(pool, p.id, "EXECUTION_DISABLED", CANCEL_MESSAGES.EXECUTION_DISABLED ?? "", GUARD_ACTOR)) ?? (await getPayment(pool, p.id));
    }
    // Everything the signer may sign comes from the stored payment row and wallet row, never from a request (PG-1).
    const signer = createGuardSigner(
      { account: wallet.address, destination: p.destination_address, currency: p.asset_currency, issuer: p.asset_issuer, value: p.amount },
      { env: deps.env, isExecutionEnabled: enabled, network: config.network },
    );
    try {
      const sent = await sendIouPayment({
        gateway: deps.gateway, signer, destination: p.destination_address, currency: p.asset_currency, issuer: p.asset_issuer, value: p.amount,
        onSigned: async (signed) => {
          await withTransaction(pool, async (c) => {
            const next = await transitionPayment(c, p.id, "reserved", "submitted", {
              tx_hash: signed.hash, last_ledger_sequence: signed.lastLedgerSequence, first_ledger_sequence: signed.firstLedgerSequence,
              signed_blob: signed.txBlob, submitted_at: true,
            });
            if (!next) throw new Error("PAYMENT_NO_LONGER_RESERVED"); // sweeper won the race: nothing is submitted
            await appendAudit(c, {
              business_id: p.business_id, actor_type: GUARD_ACTOR.type, actor_id: GUARD_ACTOR.id, event_type: "payment.signed", entity_type: "payment",
              entity_id: p.id, metadata: { tx_hash: signed.hash, last_ledger_sequence: signed.lastLedgerSequence }, // no blob (PG-10)
            });
          });
        },
        wait: {
          timeoutMs: config.paymentWaitSeconds * 1000,
          onEvent: async (e: PaymentEvent) => {
            if (e.type === "submitted") await safeAudit(deps, p.id, p.business_id, "payment.submit_ack", { engine_result: e.ack.engineResult });
            else if (e.type === "submit_error") await safeAudit(deps, p.id, p.business_id, "payment.submit_error", { message: e.message.slice(0, 300) });
          },
        },
      });
      if (sent.outcome === undefined) return await getPayment(pool, p.id);
      return await applyOutcome(pool, p.id, sent.outcome, GUARD_ACTOR);
    } catch (err) {
      const code = err instanceof SignerError ? err.code : "XRPL_SUBMISSION_FAILED";
      deps.logger.error("payment.execute_failed", { payment_id: p.id, code, error: redactError(err) });
      // Only an unsigned payment can be cancelled. Once a hash is persisted the reconciler owns it.
      const cancelled = await cancelUnsigned(pool, p.id, code, CANCEL_MESSAGES[code] ?? "The payment could not be prepared or signed.", GUARD_ACTOR).catch(() => null);
      return cancelled ?? (await getPayment(pool, p.id));
    }
  }

  async function execute(paymentId: string): Promise<PaymentRow | null> {
    const first = await getPayment(deps.pool, paymentId);
    if (!first || first.status !== "reserved") return first;
    return queue.run(first.wallet_id, async () => {
      const client = await deps.pool.connect();
      let healthy = false;
      try {
        await acquireWalletSessionLock(client, first.wallet_id);
        try {
          return await runLocked(paymentId, first.wallet_id);
        } finally {
          healthy = await releaseWalletSessionLock(client, first.wallet_id).catch(() => false);
        }
      } finally {
        client.release(!healthy); // an unreleased advisory lock dies with the destroyed session
      }
    });
  }

  return {
    execute: (id) => {
      const p = execute(id);
      running.add(p);
      const done = (): void => void running.delete(p);
      p.then(done, done);
      return p;
    },
    idle: async () => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

/** Runs a freshly reserved payment and folds its settled state into the HTTP result (200 final, 202 still in flight). */
export async function executeAndRespond(deps: ServiceDeps, result: PaymentResult): Promise<PaymentResult> {
  const id = result.body.payment_id;
  if (result.body.status !== "reserved" || id === null || !deps.executor) return result;
  const p = await deps.executor.execute(id);
  if (!p) return result;
  const pub = toPublicPayment(p, deps.config);
  return {
    httpStatus: isInFlight(p.status) ? 202 : 200,
    body: {
      ...result.body, status: p.status, tx_hash: p.tx_hash, failure_code: p.failure_code, message: p.failure_message,
      ...(pub.explorer_url === undefined ? {} : { explorer_url: pub.explorer_url }),
    },
  };
}

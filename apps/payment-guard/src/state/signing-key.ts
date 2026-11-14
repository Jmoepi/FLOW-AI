import { redactError } from "@flow-ai/contracts";
import {
  appendAudit, getWallet, latestSigningKeyRejectionLedger, listActiveWallets, setWalletSigningKeyMode, withTransaction,
  type RegularKeyState, type WalletRow,
} from "@flow-ai/database";
import { signerMode } from "../signer/signer";
import type { ServiceDeps } from "../services/payments";

/**
 * Signing key health (M7, 10.6). When the ledger rejects the guard's regular key (tefBAD_AUTH) the wallet is marked
 * "revoked" in the database (so it survives a restart) and ALL further execution is blocked, like a broken audit chain.
 * The state is visible on /readyz and the dashboard. Public status only: no seed, key or blob is ever held here.
 */
export type SigningKeyStatusMode = "master_env" | "regular_key" | "revoked";

export interface SigningKeyStatus {
  mode: SigningKeyStatusMode;
  /** True while execution is blocked because the regular key was rejected. */
  blocked: boolean;
}

export interface SigningKeyHealth {
  /** Loads the persisted state at startup. */
  hydrate(): Promise<void>;
  status(env: NodeJS.ProcessEnv): SigningKeyStatus;
  /** Fail closed: true after a rejection, until the configured key is seen registered again (restore). */
  blocked(env: NodeJS.ProcessEnv): boolean;
  /** Called when a submit was refused for authorisation: persists "revoked", writes the audit event, blocks execution. Never throws. */
  markRevoked(wallet: Pick<WalletRow, "id" | "business_id">, info: { paymentId: string; engineResult: string }): Promise<void>;
  /**
   * Called by the balance poller with the observed ledger RegularKey. Returns the state to store on the snapshot and
   * restores the guard when the configured key is registered again after the rejected blob can no longer validate.
   */
  observe(wallet: WalletRow, observed: { regularKey: string | null; configuredAddress: string | null; ledgerIndex: number }): Promise<RegularKeyState>;
}

export function classifyRegularKey(ledgerKey: string | null, configuredAddress: string | null): RegularKeyState {
  if (configuredAddress === null) return "not_configured";
  if (ledgerKey === null) return "not_set";
  return ledgerKey === configuredAddress ? "active" : "other";
}

export function createSigningKeyHealth(deps: Pick<ServiceDeps, "pool" | "config" | "env" | "logger">): SigningKeyHealth {
  const revoked = new Set<string>();

  async function hydrate(): Promise<void> {
    const { pool, config } = deps;
    for (const w of await listActiveWallets(pool)) {
      if (w.network === config.network && (config.businessId === undefined || w.business_id === config.businessId) && w.signing_key_mode === "revoked") revoked.add(w.id);
    }
    if (revoked.size > 0) deps.logger.error("signing_key.revoked_at_startup", { wallets: revoked.size, execution: "blocked_until_a_valid_key_is_registered" });
  }

  const blocked = (_env: NodeJS.ProcessEnv): boolean => revoked.size > 0; // fail closed whatever the environment: only a restore re-opens it
  const status = (env: NodeJS.ProcessEnv): SigningKeyStatus => {
    const b = blocked(env);
    return { mode: b ? "revoked" : signerMode(env), blocked: b };
  };

  async function markRevoked(wallet: Pick<WalletRow, "id" | "business_id">, info: { paymentId: string; engineResult: string }): Promise<void> {
    revoked.add(wallet.id); // block first: even if the database write below fails, this process stops executing
    try {
      await withTransaction(deps.pool, async (c) => {
        const current = await getWallet(c, wallet.id);
        if (!current) return;
        if (current.signing_key_mode === "master_env") await setWalletSigningKeyMode(c, wallet.id, "master_env", "regular_key");
        const changed = await setWalletSigningKeyMode(c, wallet.id, "regular_key", "revoked");
        if (!changed && current.signing_key_mode === "revoked") return; // already recorded: one audit event per episode
        await appendAudit(c, {
          business_id: wallet.business_id, actor_type: "policy_service", actor_id: "payment-guard", event_type: "signing_key.revoked", entity_type: "wallet",
          entity_id: wallet.id, metadata: { payment_id: info.paymentId, engine_result: info.engineResult },
        });
      });
      deps.logger.error("signing_key.revoked", { wallet_id: wallet.id, engine_result: info.engineResult, execution: "blocked" });
    } catch (err) {
      deps.logger.error("signing_key.persist_failed", { wallet_id: wallet.id, error: redactError(err) });
    }
  }

  async function observe(wallet: WalletRow, o: { regularKey: string | null; configuredAddress: string | null; ledgerIndex: number }): Promise<RegularKeyState> {
    const state = classifyRegularKey(o.regularKey, o.configuredAddress);
    if (state !== "active") return state;
    try {
      if (wallet.signing_key_mode === "master_env" && !revoked.has(wallet.id)) {
        await setWalletSigningKeyMode(deps.pool, wallet.id, "master_env", "regular_key"); // the guard now signs with the registered key
      } else if (revoked.has(wallet.id)) {
        // Restore only when the ledger shows the configured key AND the rejected blob's LastLedgerSequence has passed (it can no longer validate).
        const lls = await latestSigningKeyRejectionLedger(deps.pool, wallet.id);
        if (lls === null || lls < o.ledgerIndex) {
          await withTransaction(deps.pool, async (c) => {
            if (await setWalletSigningKeyMode(c, wallet.id, "revoked", "regular_key")) {
              await appendAudit(c, {
                business_id: wallet.business_id, actor_type: "policy_service", actor_id: "payment-guard", event_type: "signing_key.restored", entity_type: "wallet",
                entity_id: wallet.id, metadata: { ledger_index: o.ledgerIndex },
              });
            }
          });
          revoked.delete(wallet.id);
          deps.logger.warn("signing_key.restored", { wallet_id: wallet.id });
        }
      }
    } catch (err) {
      deps.logger.warn("signing_key.observe_failed", { wallet_id: wallet.id, error: redactError(err) });
    }
    return state;
  }

  return { hydrate, status, blocked, markRevoked, observe };
}

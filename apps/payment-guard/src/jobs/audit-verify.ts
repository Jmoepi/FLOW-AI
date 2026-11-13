import { randomBytes } from "node:crypto";
import { listBusinessIds, verifyAuditChain } from "@flow-ai/database";
import { redactError } from "@flow-ai/contracts";
import type { ServiceDeps } from "../services/payments";
import { createLoop, type Loop } from "./loop";

export type AuditChainState = "unverified" | "ok" | "broken" | "error";

/** Counts and flags only: no business ids, row contents or hashes (AL-3, G-3). */
export interface AuditIntegrityStatus {
  state: AuditChainState;
  last_checked_at: string | null;
  /** True while a detected break has not been acknowledged by the operator: new execution is blocked. */
  blocked: boolean;
}

export interface AuditIntegrity {
  /** Verifies every in-scope business chain now and records the result. Never throws. */
  runOnce(): Promise<AuditIntegrityStatus>;
  status(env: NodeJS.ProcessEnv): AuditIntegrityStatus;
  /** Fail closed: true after a detected break until the operator acknowledges it. */
  blocked(env: NodeJS.ProcessEnv): boolean;
  /** Identifier of the current break episode, to be set as AUDIT_BREAK_ACK to acknowledge it. Null when not broken. */
  breakId(): string | null;
}

/** Operator acknowledgement: set AUDIT_BREAK_ACK to the break id from the guard log. Re-read on every call, like the kill switch (13.1C). */
export const ACK_ENV = "AUDIT_BREAK_ACK";

export function createAuditIntegrity(deps: Pick<ServiceDeps, "pool" | "config" | "env" | "logger">): AuditIntegrity {
  let state: AuditChainState = "unverified";
  let lastCheckedAt: string | null = null;
  let currentBreak: string | null = null;
  let ackLogged = false;
  const isAcked = (env: NodeJS.ProcessEnv): boolean => currentBreak !== null && env[ACK_ENV] === currentBreak;
  const blocked = (env: NodeJS.ProcessEnv): boolean => state === "broken" && !isAcked(env);
  const status = (env: NodeJS.ProcessEnv): AuditIntegrityStatus => ({ state, last_checked_at: lastCheckedAt, blocked: blocked(env) });

  async function runOnce(): Promise<AuditIntegrityStatus> {
    const { pool, config, logger } = deps;
    let brokenCount = 0;
    let checked = 0;
    try {
      const ids = config.businessId !== undefined ? [config.businessId] : await listBusinessIds(pool);
      for (const id of ids) {
        checked++;
        if (!(await verifyAuditChain(pool, id))) brokenCount++;
      }
    } catch (err) {
      // A failed check is not a detected break: keep a previous "broken" state, otherwise report "error" and retry next tick.
      if (state !== "broken") state = "error";
      lastCheckedAt = new Date().toISOString();
      logger.error("audit.verify_failed", { error: redactError(err) });
      return status(deps.env());
    }
    lastCheckedAt = new Date().toISOString();
    if (brokenCount > 0) {
      if (state !== "broken") {
        currentBreak = `brk-${randomBytes(6).toString("hex")}`;
        ackLogged = false;
        logger.error("audit.chain_broken", { break_id: currentBreak, businesses_checked: checked, businesses_broken: brokenCount, execution: "blocked_until_acknowledged" });
      }
      state = "broken";
      if (isAcked(deps.env()) && !ackLogged) {
        ackLogged = true;
        logger.warn("audit.chain_break_acknowledged", { break_id: currentBreak });
      }
    } else {
      if (state === "broken") logger.warn("audit.chain_recovered", { break_id: currentBreak });
      state = "ok";
      currentBreak = null;
      logger.info("audit.verified", { businesses_checked: checked });
    }
    return status(deps.env());
  }

  return { runOnce, status, blocked, breakId: () => currentBreak };
}

export function createAuditVerifier(deps: ServiceDeps, integrity: AuditIntegrity): Loop {
  return createLoop("audit-verify", deps.config.auditVerifyIntervalSeconds * 1000, () => integrity.runOnce(), deps.logger);
}

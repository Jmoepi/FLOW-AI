import { redactError } from "@flow-ai/contracts";
import { pruneLoginAttempts, revokeExpiredSessions } from "@flow-ai/database";
import type { WebDeps } from "./deps";
/** Rate-limit windows older than this are deleted (the database policy refuses anything newer than one day). */
export const LOGIN_ATTEMPT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
export const FIRST_RUN_DELAY_MS = 60_000;
export const RUN_INTERVAL_MS = 60 * 60 * 1000;
/** One pass: prune old login_attempts windows and revoke sessions past their absolute expiry. Returns counts only. */
export async function runHousekeepingOnce(deps: Pick<WebDeps, "pool" | "now" | "logger">): Promise<{ pruned: number; revoked: number }> {
  const now = deps.now();
  const pruned = await pruneLoginAttempts(deps.pool, new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS));
  const revoked = await revokeExpiredSessions(deps.pool, now);
  deps.logger.info("housekeeping.done", { pruned_login_attempts: pruned, revoked_sessions: revoked });
  return { pruned, revoked };
}
export interface HousekeepingOptions {
  firstDelayMs?: number;
  intervalMs?: number;
}
/**
 * Runs the job once after a short delay and then hourly, on timers that do not keep the process alive. Passes never
 * overlap, and a failed pass is logged (redacted) and retried on the next tick: it never throws into the server.
 */
export function startHousekeeping(getDeps: () => Promise<WebDeps>, onError: (message: string) => void, opts: HousekeepingOptions = {}): { stop: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    getDeps()
      .then((deps) => runHousekeepingOnce(deps))
      .catch((err: unknown) => onError(redactError(err)))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, opts.intervalMs ?? RUN_INTERVAL_MS);
    timer.unref();
  }, opts.firstDelayMs ?? FIRST_RUN_DELAY_MS);
  first.unref();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    stop: () => {
      clearTimeout(first);
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

import { redactError } from "@flow-ai/contracts";
import type { Logger } from "../logger";

export interface Loop {
  start(): void;
  /** Stops the timer and waits for a run that is already in flight. */
  stop(): Promise<void>;
}

/** Interval loop with an overlap guard: a tick is skipped while the previous run is still going. Errors are logged redacted, never thrown. */
export function createLoop(name: string, intervalMs: number, task: () => Promise<unknown>, logger: Logger): Loop {
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (current !== undefined || stopped) return;
    current = task().then(
      () => undefined,
      (err: unknown) => logger.error("job.failed", { job: name, error: redactError(err) }),
    ).finally(() => {
      current = undefined;
    });
  };
  return {
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await current;
    },
  };
}

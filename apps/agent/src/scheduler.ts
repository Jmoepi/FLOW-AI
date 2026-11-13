export interface SchedulerOptions {
  intervalMinutes: number;
  /** One run. Errors are swallowed by the scheduler (logged by the caller); the next tick still happens. */
  runOnce: () => Promise<void>;
  onError?: (err: unknown) => void;
  onSkip?: () => void;
  /** Fire the first tick right away instead of after one interval. */
  runImmediately?: boolean;
}

export interface Scheduler {
  start(): void;
  /** Stops scheduling and waits for the active run, if any. */
  stop(): Promise<void>;
  isRunning(): boolean;
}

/**
 * Interval trigger with overlap protection. A setTimeout chain (not setInterval) so the next tick is scheduled only
 * after the previous one was handled; a tick that fires while a run is active is skipped, never queued. The guard-side
 * unique running-run index is the second lock.
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const ms = opts.intervalMinutes * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let stopped = true;

  const tick = (): void => {
    if (stopped) return;
    if (active !== null) {
      opts.onSkip?.();
    } else {
      active = opts
        .runOnce()
        .catch((err: unknown) => opts.onError?.(err))
        .finally(() => {
          active = null;
        });
    }
    timer = setTimeout(tick, ms);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(tick, opts.runImmediately === true ? 0 : ms);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (active !== null) await active;
    },
    isRunning: () => active !== null,
  };
}

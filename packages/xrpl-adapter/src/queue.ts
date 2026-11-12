/**
 * Per-key (per-wallet) serialisation. Tasks for the same key run strictly one after another, so two sends
 * from one account can never autofill the same Sequence. Different keys run concurrently.
 * In-process only (spec 6.4 requires the guard to run a single signer process per wallet in the MVP).
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export const walletQueue = new KeyedQueue();

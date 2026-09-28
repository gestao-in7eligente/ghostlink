export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

/** FIFO counting semaphore: at most `max` tasks run at once, the rest wait in order. */
export function createSemaphore(max: number): Semaphore {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };
  // Hands the slot straight to the next waiter, so `active` never exceeds `max`.
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

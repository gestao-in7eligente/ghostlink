import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../src/util/semaphore.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createSemaphore', () => {
  it('never runs more than `max` tasks at once and starts waiters in FIFO order', async () => {
    const sem = createSemaphore(2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const runs = gates.map((g, i) => sem.run(async () => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await g.promise;
      running--;
      return i;
    }));
    await tick();
    expect(started).toEqual([0, 1]);
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(3);
    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    gates[2]!.resolve();
    gates[3]!.resolve();
    gates[4]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(sem.active).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(sem.active).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a non-positive limit', () => {
    expect(() => createSemaphore(0)).toThrow(RangeError);
    expect(() => createSemaphore(1.5)).toThrow(RangeError);
  });
});

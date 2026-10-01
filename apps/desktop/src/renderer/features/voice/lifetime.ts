// The voice parts' runtimes (the call, the store sync, the pencil) run while a component
// using them is mounted, and also while a call is on: the call goes on when the screen moves
// to the Home screen or another server (spec 2026-10-01-chamada-continua-design.md §1).
import { useVoiceStore } from './state.js';

/**
 * Runs `run` from the first user on. The last user stops it, unless a call is on: then it
 * stops once the call ends with nobody left (the screen moving from a server to the Home
 * screen unmounts one layout before mounting the other; the call must not end in between).
 */
export function lifetime(run: () => () => void): { retain(): void; release(): void } {
  let users = 0;
  let stop: (() => void) | null = null;
  let waiting: (() => void) | null = null;
  const maybeStop = () => {
    if (users > 0 || stop === null) return;
    if (useVoiceStore.getState().call.status !== 'idle') {
      // Stopped after the store's listeners ran, never in the middle of a notification.
      waiting ??= useVoiceStore.subscribe((v) => {
        if (v.call.status === 'idle') queueMicrotask(maybeStop);
      });
      return;
    }
    waiting?.();
    waiting = null;
    const end = stop;
    stop = null;
    end();
  };
  return {
    retain() {
      users++;
      waiting?.();
      waiting = null;
      stop ??= run();
    },
    release() {
      if (--users === 0) maybeStop();
    },
  };
}

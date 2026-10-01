// The pencil's batches (spec 2026-10-01-lapis-na-tela-design.md §3): the points of a stroke go
// out every ~50 ms, at most 64 per batch, and a point closer than ~0.002 to the previous one
// is dropped. The clock and the sender come in, so it is tested without timers or a server.
import { SCREEN_DRAW_LIMITS, type DrawPoint } from '@ghostlink/shared';

export const BATCH_MS = 50;
/** Points nearer than this to the previous one (in frame units) add nothing. */
export const MIN_STEP = 0.002;

export interface StrokeBatch {
  strokeId: string;
  points: DrawPoint[];
  /** The stroke's last batch. */
  end: boolean;
}

export interface BatcherDeps {
  send(batch: StrokeBatch): void;
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** A new stroke id (short, [A-Za-z0-9_-]). */
  newId(): string;
}

/** Whether `b` is far enough from `a` to keep. */
export function farEnough(a: DrawPoint, b: DrawPoint, step = MIN_STEP): boolean {
  return Math.hypot(b[0] - a[0], b[1] - a[1]) >= step;
}

/** One person's strokes, one at a time: begin, add while dragging, end. */
export class StrokeBatcher {
  readonly #deps: BatcherDeps;
  #strokeId: string | null = null;
  #pending: DrawPoint[] = [];
  /** The last point kept in this stroke (sent or pending). */
  #last: DrawPoint | null = null;
  #cancel: (() => void) | null = null;

  constructor(deps: BatcherDeps) {
    this.#deps = deps;
  }

  /** The stroke being drawn, or null. */
  get strokeId(): string | null {
    return this.#strokeId;
  }

  /** Starts a stroke at `point` (ending one still open). Returns its id. */
  begin(point: DrawPoint): string {
    if (this.#strokeId !== null) this.end();
    const id = this.#deps.newId();
    this.#strokeId = id;
    this.#last = null;
    this.add(point);
    return id;
  }

  /** Adds a point to the open stroke; false when it was dropped (too close, or no stroke). */
  add(point: DrawPoint): boolean {
    if (this.#strokeId === null) return false;
    if (this.#last !== null && !farEnough(this.#last, point)) return false;
    this.#last = point;
    this.#pending.push(point);
    if (this.#pending.length >= SCREEN_DRAW_LIMITS.maxPoints) this.#flush(false);
    else this.#cancel ??= this.#deps.schedule(() => {
      this.#cancel = null;
      this.#flush(false);
    }, BATCH_MS);
    return true;
  }

  /** Ends the open stroke: what is pending goes now, marked as the last batch. */
  end(): void {
    if (this.#strokeId === null) return;
    // The last batch carries at least one point (the server takes 1 to 64).
    if (this.#pending.length === 0 && this.#last !== null) this.#pending.push(this.#last);
    this.#flush(true);
    this.#strokeId = null;
    this.#last = null;
  }

  #flush(end: boolean): void {
    this.#cancel?.();
    this.#cancel = null;
    if (this.#pending.length === 0 || this.#strokeId === null) return;
    const points = this.#pending;
    this.#pending = [];
    this.#deps.send({ strokeId: this.#strokeId, points, end });
  }
}

/** A stroke id: 8 random bytes in base64url (11 characters). */
export function newStrokeId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(8));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

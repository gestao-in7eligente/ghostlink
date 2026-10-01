// The strokes on one shared screen and how long they live (spec 2026-10-01-lapis-na-tela-design.md
// §1, §3): each stroke stays ~3 s after it ends, fading in the last half second, like Slack's.
// The clock is injected. Used by the app's canvases and by the overlay over the real screen.
import type { DrawPoint } from '@ghostlink/shared';

/** A stroke is fully visible until this long after it ended… */
export const FADE_START_MS = 2_500;
/** …and gone this long after it ended. */
export const FADE_END_MS = 3_000;
/** A stroke whose end never came (its author dropped) is gone this long after its last batch. */
export const STALE_MS = 10_000;
/** Bounds against a flood: the oldest stroke goes first. */
export const MAX_STROKES = 256;
export const MAX_POINTS_PER_STROKE = 4_096;

/** One batch of a stroke, from the server, from this app's own pencil, or relayed to the overlay. */
export interface StrokeInput {
  /** Unique per author and stroke: `${userId}:${strokeId}`. */
  key: string;
  /** The author: their color and name label. */
  userId: string;
  points: readonly DrawPoint[];
  end: boolean;
}

export interface Stroke {
  key: string;
  userId: string;
  points: DrawPoint[];
  /** When its last batch arrived here; null while it is being drawn. */
  endedAt: number | null;
  /** When its latest batch arrived here. */
  updatedAt: number;
}

/** 1 until FADE_START_MS after the end, then down to 0 at FADE_END_MS. */
export function strokeAlpha(stroke: Pick<Stroke, 'endedAt' | 'updatedAt'>, now: number): number {
  let end = stroke.endedAt;
  // No end yet: after a long silence the stroke counts as ended, so it still fades out on time.
  if (end === null && now - stroke.updatedAt >= STALE_MS - FADE_END_MS) end = stroke.updatedAt + STALE_MS - FADE_END_MS;
  if (end === null) return 1;
  const age = now - end;
  if (age <= FADE_START_MS) return 1;
  if (age >= FADE_END_MS) return 0;
  return (FADE_END_MS - age) / (FADE_END_MS - FADE_START_MS);
}

export class StrokeStore {
  readonly #strokes = new Map<string, Stroke>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  get size(): number {
    return this.#strokes.size;
  }

  has(key: string): boolean {
    return this.#strokes.has(key);
  }

  /** Adds a batch: a new stroke, or more points (and maybe the end) of one being drawn. */
  apply(input: StrokeInput): void {
    const now = this.#now();
    this.prune();
    let stroke = this.#strokes.get(input.key);
    if (stroke && stroke.endedAt !== null) return; // a batch after the end adds nothing
    if (!stroke) {
      if (input.points.length === 0) return;
      while (this.#strokes.size >= MAX_STROKES) this.#strokes.delete(this.#strokes.keys().next().value!);
      stroke = { key: input.key, userId: input.userId, points: [], endedAt: null, updatedAt: now };
      this.#strokes.set(input.key, stroke);
    }
    const room = MAX_POINTS_PER_STROKE - stroke.points.length;
    if (room > 0) stroke.points.push(...input.points.slice(0, room));
    stroke.updatedAt = now;
    if (input.end) stroke.endedAt = now;
  }

  /** The strokes to paint now, oldest first, with their opacity. Faded ones are dropped. */
  visible(): { stroke: Stroke; alpha: number }[] {
    const now = this.#now();
    const out: { stroke: Stroke; alpha: number }[] = [];
    for (const [key, stroke] of this.#strokes) {
      const alpha = strokeAlpha(stroke, now);
      if (alpha <= 0) this.#strokes.delete(key);
      else out.push({ stroke, alpha });
    }
    return out;
  }

  /** Drops the strokes that faded out. */
  prune(): void {
    const now = this.#now();
    for (const [key, stroke] of this.#strokes) if (strokeAlpha(stroke, now) <= 0) this.#strokes.delete(key);
  }

  clear(): void {
    this.#strokes.clear();
  }
}

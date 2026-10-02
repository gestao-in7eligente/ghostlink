// The call's mini window while I share my screen (spec 2026-10-02-janelinha-da-chamada-design.md),
// its rules without React or the DOM: who the video area shows, the row of people, and when the
// window is open (with the share, until ✕, back on the next share).

/** What the video area is fed: who is in the call, who speaks now, whose camera is there. */
export interface FeaturedInput {
  /** Everyone in the call, in the channel's order. */
  participants: readonly string[];
  /** Who speaks right now, loudest first (LiveKit's order; me while my microphone is open). */
  speaking: readonly string[];
  /** Whose camera picture this app has (mine included). */
  cameras: readonly string[];
  /** My own user id. */
  self: string | null;
}

/** What the video area remembers between two looks. */
export interface FeaturedMemory {
  /** The last one who spoke with the camera on. */
  lastCamera: string | null;
  /** The last one who spoke. */
  lastSpeaker: string | null;
}

export const NO_FEATURED_MEMORY: FeaturedMemory = { lastCamera: null, lastSpeaker: null };

/** The person the video area shows: their camera, or their photo (with the green ring while they speak). */
export interface Featured {
  userId: string;
  camera: boolean;
  speaking: boolean;
}

/** `current` while it still qualifies (no jumping between two people speaking at once), else the first of `list`. */
function keep(current: string | null, list: readonly string[]): string | null {
  return current !== null && list.includes(current) ? current : (list[0] ?? null);
}

/**
 * Who the video area shows (spec §2.2): the camera of whoever is speaking, which stays on the last
 * one who spoke with the camera on (me included); with a camera on but nobody having spoken with
 * it yet, someone else's before mine. With no camera on: the photo of whoever speaks, else of the
 * last one who spoke, else of someone else in the call, else mine. Null with nobody in the call.
 */
export function chooseFeatured(input: FeaturedInput, memory: FeaturedMemory): { featured: Featured | null; memory: FeaturedMemory } {
  const here = (u: string) => input.participants.includes(u);
  const speaking = input.speaking.filter(here);
  const cameras = input.participants.filter((u) => input.cameras.includes(u));
  const othersFirst = (list: readonly string[]) => [...list.filter((u) => u !== input.self), ...list.filter((u) => u === input.self)];

  const speakingWithCamera = speaking.filter((u) => cameras.includes(u));
  const next: FeaturedMemory = {
    lastCamera: speakingWithCamera.length > 0 ? keep(memory.lastCamera, speakingWithCamera) : memory.lastCamera,
    lastSpeaker: speaking.length > 0 ? keep(memory.lastSpeaker, speaking) : memory.lastSpeaker,
  };
  const pick = (userId: string, camera: boolean) => ({ featured: { userId, camera, speaking: speaking.includes(userId) }, memory: next });

  if (cameras.length > 0) {
    const camera = next.lastCamera !== null && cameras.includes(next.lastCamera) ? next.lastCamera : othersFirst(cameras)[0]!;
    return pick(camera, true);
  }
  // While someone speaks, lastSpeaker is one of them.
  const photo = next.lastSpeaker !== null && here(next.lastSpeaker) ? next.lastSpeaker : othersFirst(input.participants)[0];
  return photo === undefined ? { featured: null, memory: next } : pick(photo, false);
}

/** At most this many photos in the row of people; the rest is "+N". */
export const PEOPLE_SHOWN = 6;

/** The row of people: the first PEOPLE_SHOWN in the channel's order, and how many more there are. */
export function peopleRow(participants: readonly string[], max = PEOPLE_SHOWN): { shown: string[]; more: number } {
  return { shown: participants.slice(0, max), more: Math.max(0, participants.length - max) };
}

/** What opening and closing the window does (CallWindow.tsx: the popup and its portal). */
export interface CallWindowOps {
  /** Opens it; false when it could not open (main refused it). */
  open(): boolean;
  close(): void;
}

/**
 * When the mini window is open: while my share is live, from its start to its end (stopped by any
 * path, or the call ended). ✕ closes it until the next share; so does closing it by other means
 * (Alt+F4), and a refused window is not asked for again during the same share.
 */
export class CallWindowLifecycle {
  readonly #ops: CallWindowOps;
  #live = false;
  #dismissed = false;
  #open = false;
  #disposed = false;

  constructor(ops: CallWindowOps) {
    this.#ops = ops;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** Whether my share is live; a share that ends lets the next one open the window again. */
  update(live: boolean): void {
    if (!live) this.#dismissed = false;
    this.#live = live;
    this.#apply();
  }

  /** ✕: closed until the next share (the share goes on). */
  dismiss(): void {
    this.#dismissed = true;
    this.#apply();
  }

  /** The window went away by itself (Alt+F4, the system): as ✕. */
  gone(): void {
    if (!this.#open) return;
    this.#dismissed = true;
    this.#open = false;
    this.#ops.close();
  }

  /** The page goes (or the host unmounts): closed for good. */
  dispose(): void {
    this.#disposed = true;
    this.#apply();
  }

  #apply(): void {
    const wanted = this.#live && !this.#dismissed && !this.#disposed;
    if (wanted === this.#open) return;
    if (!wanted) {
      this.#open = false;
      this.#ops.close();
      return;
    }
    this.#open = this.#ops.open();
    if (!this.#open) this.#dismissed = true;
  }
}

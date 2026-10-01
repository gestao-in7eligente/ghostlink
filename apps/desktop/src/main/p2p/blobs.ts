// Files between two friends (attachments spec §3, with the frames the profile photo spec §5
// sketched), over the friend's link:
//
//   blob.want    { hash, from? }                  "send me the parts of this file from part `from` on"
//   blob.part    { hash, index, total, data }     one part: 32 KiB of the file (the last may be shorter)
//   blob.missing { hash }                         "I do not have it, or it is not yours to ask for"
//
// The asking side pulls one window of 16 parts at a time and asks for the next once the window
// is in, so at most 512 KiB of a file is on its way at any moment. Each side runs at most 2
// transfers per link: the asker never starts a third, and the answerer ignores a third. The
// answerer also hands out at most WANT_PER_SECOND windows per link (a token bucket).
//
// The answerer only serves a file that a message of the conversation shared with that friend
// carries, and that it has whole (dm.ts decides, `mayServe`). The asker writes the parts to a
// temporary file and keeps it only if the SHA-256 of the whole matches the hash it asked for;
// a part of the wrong size, or bytes that do not hash right, fail the transfer and nothing stays.
import type { DmFileState } from '../../shared/dmTypes.js';
import type { DmFiles, IncomingFile } from './dmFiles.js';
import { PART_BYTES, type BlobMessage } from './frames.js';
import type { PeerLink } from './friends.js';
import type { Timers } from './inbox.js';

/** Parts asked for at a time, per transfer. */
export const WINDOW_PARTS = 16;
/** spec §3: at most this many transfers at once on one link, each way. */
export const TRANSFERS_PER_LINK = 2;
/** A transfer that hears nothing for this long fails (the asker) or is forgotten (the answerer). */
export const PART_TIMEOUT_MS = 20_000;
/** The answerer's limit per link: windows per second, and the burst it allows. */
export const WANT_PER_SECOND = 32;
export const WANT_BURST = 64;

const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');

/** How many parts a file of that size has. */
export function partsOf(size: number): number {
  return Math.max(1, Math.ceil(size / PART_BYTES));
}

/** The exact length of part `index` of a file of that size. */
function partLength(size: number, index: number): number {
  return Math.min(PART_BYTES, size - index * PART_BYTES);
}

export interface BlobsDeps {
  files: Pick<DmFiles, 'has' | 'size' | 'read' | 'incoming'>;
  /** Whether that friend may have this file from us: a message we share with them carries it. */
  mayServe(peer: Uint8Array, hash: string): boolean;
  /** A transfer moved: queued (absent), receiving (loading), kept (ready) or failed. */
  changed(hash: string, state: DmFileState, received: number): void;
  timers: Timers;
  now: () => number;
}

/** A file this side wants. */
interface Fetch {
  hash: string;
  size: number;
  total: number;
  /** Whom it comes from (hex of the friend key). */
  peer: string;
  /** queued: waiting for a free slot or for the friend's link; active: parts are coming. */
  state: 'queued' | 'active';
  /** The next part expected, and the end (exclusive) of the window asked for. */
  next: number;
  until: number;
  received: number;
  file: IncomingFile | null;
  timer: unknown;
}

/** What this side serves on one link. */
interface Serving {
  link: PeerLink;
  /** hash → when it was last asked for. */
  active: Map<string, number>;
  tokens: number;
  refilled: number;
}

export class Blobs {
  readonly #d: BlobsDeps;
  /** Every file wanted, by hash (each comes from one friend). */
  readonly #fetches = new Map<string, Fetch>();
  /** Friends whose link is up, by hex key. */
  readonly #links = new Map<string, Serving>();

  constructor(deps: BlobsDeps) {
    this.#d = deps;
  }

  /** The friend's link is up: queued transfers from them start. */
  up(peer: Uint8Array, link: PeerLink): void {
    const id = hexOf(peer);
    this.#drop(id);
    this.#links.set(id, { link, active: new Map(), tokens: WANT_BURST, refilled: this.#d.now() });
    this.#pump(id);
  }

  /** The link closed: what was coming from that friend waits for the next one, from the start. */
  down(peer: Uint8Array, link: PeerLink): void {
    const id = hexOf(peer);
    if (this.#links.get(id)?.link !== link) return;
    this.#drop(id);
  }

  /**
   * Wants a file from that friend. It starts at once when their link is up and a slot is free;
   * else it waits. Nothing happens when it is already here or already wanted.
   */
  fetch(peer: Uint8Array, hash: string, size: number): void {
    if (this.#fetches.has(hash) || this.#d.files.has(hash)) return;
    const fetch: Fetch = { hash, size, total: partsOf(size), peer: hexOf(peer), state: 'queued', next: 0, until: 0, received: 0, file: null, timer: null };
    this.#fetches.set(hash, fetch);
    this.#pump(fetch.peer);
  }

  /** Stops wanting a file (its message was deleted). Says nothing: the caller knows. */
  cancel(hash: string): void {
    const fetch = this.#fetches.get(hash);
    if (!fetch) return;
    this.#stop(fetch);
    this.#fetches.delete(hash);
    this.#pump(fetch.peer);
  }

  /** Where a wanted file stands; null when it is not wanted. */
  progress(hash: string): { state: 'absent' | 'loading'; received: number } | null {
    const fetch = this.#fetches.get(hash);
    if (!fetch) return null;
    return fetch.state === 'active' ? { state: 'loading', received: fetch.received } : { state: 'absent', received: 0 };
  }

  receive(peer: Uint8Array, message: BlobMessage, link: PeerLink): void {
    const id = hexOf(peer);
    const serving = this.#links.get(id);
    if (serving?.link !== link) return;
    switch (message.t) {
      case 'blob.want':
        return this.#onWant(id, serving, message.hash, message.from ?? 0);
      case 'blob.part':
        return this.#onPart(id, message);
      case 'blob.missing':
        return this.#onMissing(id, message.hash);
    }
  }

  dispose(): void {
    for (const fetch of this.#fetches.values()) this.#stop(fetch);
    this.#fetches.clear();
    this.#links.clear();
  }

  // Asking.

  /** Starts queued transfers from that friend while slots are free. */
  #pump(peer: string): void {
    const serving = this.#links.get(peer);
    if (!serving) return;
    // Counted again every round: answers can arrive while a want goes out (and start or end others).
    for (;;) {
      const mine = [...this.#fetches.values()].filter((f) => f.peer === peer);
      const fetch = mine.find((f) => f.state === 'queued');
      if (!fetch || mine.filter((f) => f.state === 'active').length >= TRANSFERS_PER_LINK || this.#links.get(peer) !== serving) return;
      // It may have arrived meanwhile (the same file in another message).
      if (this.#d.files.has(fetch.hash)) {
        this.#fetches.delete(fetch.hash);
        this.#d.changed(fetch.hash, 'ready', fetch.size);
        continue;
      }
      try {
        fetch.file = this.#d.files.incoming(fetch.hash);
      } catch {
        this.#fetches.delete(fetch.hash);
        this.#d.changed(fetch.hash, 'failed', 0);
        continue;
      }
      fetch.state = 'active';
      this.#d.changed(fetch.hash, 'loading', 0);
      this.#ask(fetch, serving);
    }
  }

  /** Asks for the next window. */
  #ask(fetch: Fetch, serving: Serving): void {
    fetch.until = Math.min(fetch.total, fetch.next + WINDOW_PARTS);
    serving.link.send({ t: 'blob.want', hash: fetch.hash, ...(fetch.next === 0 ? {} : { from: fetch.next }) });
    this.#arm(fetch);
  }

  #arm(fetch: Fetch): void {
    this.#d.timers.clearTimeout(fetch.timer);
    fetch.timer = this.#d.timers.setTimeout(() => {
      fetch.timer = null;
      if (this.#fetches.get(fetch.hash) === fetch) this.#fail(fetch);
    }, PART_TIMEOUT_MS);
  }

  #onPart(peer: string, part: Extract<BlobMessage, { t: 'blob.part' }>): void {
    const fetch = this.#fetches.get(part.hash);
    // Late parts of a transfer that was dropped or redone are ignored.
    if (!fetch || fetch.peer !== peer || fetch.state !== 'active' || part.index !== fetch.next) return;
    let data: Uint8Array;
    try {
      data = Buffer.from(part.data, 'base64url');
    } catch {
      return this.#fail(fetch);
    }
    if (part.total !== fetch.total || data.byteLength !== partLength(fetch.size, part.index)) return this.#fail(fetch);
    try {
      fetch.file!.write(data);
    } catch {
      return this.#fail(fetch);
    }
    fetch.next++;
    fetch.received += data.byteLength;
    if (fetch.next === fetch.total) return this.#finish(fetch);
    if (fetch.next < fetch.until) return this.#arm(fetch);
    // A window is in: one progress event per window, then the next one.
    this.#d.changed(fetch.hash, 'loading', fetch.received);
    const serving = this.#links.get(peer);
    if (serving) this.#ask(fetch, serving);
  }

  #finish(fetch: Fetch): void {
    this.#d.timers.clearTimeout(fetch.timer);
    let kept: boolean;
    try {
      kept = fetch.file!.finish();
    } catch {
      kept = false; // the disk refused the rename: nothing is kept
    }
    fetch.file = null;
    this.#fetches.delete(fetch.hash);
    this.#d.changed(fetch.hash, kept ? 'ready' : 'failed', kept ? fetch.size : 0);
    this.#pump(fetch.peer);
  }

  #onMissing(peer: string, hash: string): void {
    const fetch = this.#fetches.get(hash);
    if (fetch?.peer === peer && fetch.state === 'active') this.#fail(fetch);
  }

  /** Nothing of it stays; the person may try again. */
  #fail(fetch: Fetch): void {
    this.#stop(fetch);
    this.#fetches.delete(fetch.hash);
    this.#d.changed(fetch.hash, 'failed', 0);
    this.#pump(fetch.peer);
  }

  /** Back to the start: no file, no timer. */
  #stop(fetch: Fetch): void {
    this.#d.timers.clearTimeout(fetch.timer);
    fetch.timer = null;
    fetch.file?.abort();
    fetch.file = null;
    fetch.state = 'queued';
    fetch.next = 0;
    fetch.until = 0;
    fetch.received = 0;
  }

  /** The link is gone: active transfers from that friend wait again (absent); nothing is served to them. */
  #drop(peer: string): void {
    if (!this.#links.delete(peer)) return;
    for (const fetch of this.#fetches.values()) {
      if (fetch.peer !== peer || fetch.state !== 'active') continue;
      this.#stop(fetch);
      this.#d.changed(fetch.hash, 'absent', 0);
    }
  }

  // Answering.

  #onWant(peer: string, serving: Serving, hash: string, from: number): void {
    const size = this.#d.mayServe(Buffer.from(peer, 'hex'), hash) ? this.#d.files.size(hash) : null;
    if (size === null || size === 0) {
      serving.link.send({ t: 'blob.missing', hash });
      return;
    }
    const total = partsOf(size);
    if (from >= total) return;
    const now = this.#d.now();
    for (const [other, at] of serving.active) if (now - at >= PART_TIMEOUT_MS) serving.active.delete(other);
    // A third file at once, or too many windows: a well-behaved friend never asks so; ignored.
    if (!serving.active.has(hash) && serving.active.size >= TRANSFERS_PER_LINK) return;
    serving.tokens = Math.min(WANT_BURST, serving.tokens + ((now - serving.refilled) / 1000) * WANT_PER_SECOND);
    serving.refilled = now;
    if (serving.tokens < 1) return;
    serving.tokens--;
    const until = Math.min(total, from + WINDOW_PARTS);
    let bytes: Uint8Array;
    try {
      bytes = this.#d.files.read(hash, from * PART_BYTES, Math.min(size, until * PART_BYTES) - from * PART_BYTES);
    } catch {
      serving.link.send({ t: 'blob.missing', hash });
      return;
    }
    for (let index = from; index < until; index++) {
      const start = (index - from) * PART_BYTES;
      const data = bytes.subarray(start, start + partLength(size, index));
      serving.link.send({ t: 'blob.part', hash, index, total, data: Buffer.from(data).toString('base64url') });
    }
    if (until === total) serving.active.delete(hash);
    else serving.active.set(hash, now);
  }
}

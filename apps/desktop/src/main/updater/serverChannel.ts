// What the app remembers of the update channel each saved server advertises (plan 2026-10-05-v083-troca-automatica,
// Task 3): a neutral `updateChannel.url` per serverKeyId with when it was last seen, in <userData>/update-channels.json
// (0600), for saved servers only. The most recently seen one drives a one-time cross-grade (updater/crossGrade.ts).
// The URL is no more secret than what a member already holds, but it stays in main: it never reaches the saved list
// the page reads. A damaged entry is dropped on load, not the whole file. Nothing here names an edition.
import { join } from 'node:path';
import { z } from 'zod';
import { isUpdateChannelUrl, updateChannelWelcomeSchema } from '@ghostlink/shared';
import { readJsonFile, writeJsonAtomic } from '../files.js';

export const UPDATE_CHANNELS_FILE = 'update-channels.json';
export const MAX_UPDATE_CHANNELS = 1_000;
/** A repeated channel refreshes its seenAt on disk at most this often, so steady welcomes do not keep rewriting. */
export const SEEN_REFRESH_MS = 6 * 60 * 60 * 1000;

const SERVER_KEY_ID = /^[A-Za-z0-9_-]{43}$/;

/** One saved server's advertised channel and when this app last saw it (ms). */
export interface SeenChannel {
  url: string;
  seenAt: number;
}

const entrySchema = z.object({
  url: z.string(),
  seenAt: z.number().int().nonnegative(),
});

// Values are read loosely so a single damaged entry is dropped on load rather than quarantining the whole file.
const fileSchema = z.object({
  version: z.literal(1),
  channels: z.record(z.string(), z.unknown()),
});

export interface ServerChannelOptions {
  now?: () => number;
  /** Whether the server is in the saved list (SavedServersStore): only saved servers are kept. */
  saved?: (serverKeyId: string) => boolean;
}

export class ServerChannelStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #saved: (serverKeyId: string) => boolean;
  #channels: Map<string, SeenChannel>;

  private constructor(path: string, channels: Map<string, SeenChannel>, opts: ServerChannelOptions) {
    this.#path = path;
    this.#channels = channels;
    this.#now = opts.now ?? Date.now;
    this.#saved = opts.saved ?? (() => true);
  }

  static load(userDataDir: string, opts: ServerChannelOptions = {}): ServerChannelStore {
    const path = join(userDataDir, UPDATE_CHANNELS_FILE);
    const file = readJsonFile(path, fileSchema, (): z.infer<typeof fileSchema> => ({ version: 1, channels: {} }));
    const channels = new Map<string, SeenChannel>();
    for (const [serverKeyId, raw] of Object.entries(file.channels)) {
      if (!SERVER_KEY_ID.test(serverKeyId)) continue;
      const parsed = entrySchema.safeParse(raw);
      // A damaged entry (an unusable URL, a missing field) is dropped; the good ones still load.
      if (!parsed.success || !isUpdateChannelUrl(parsed.data.url)) continue;
      channels.set(serverKeyId, { url: parsed.data.url, seenAt: parsed.data.seenAt });
    }
    return new ServerChannelStore(path, channels, opts);
  }

  /**
   * A welcome's neutral `updateChannel` of a saved server; anything unreadable, a URL the app cannot use (not https,
   * over-long, unparseable), or a server that is not saved, is ignored. Returns true when the most recently seen
   * channel among saved servers changed its URL (a cross-grade may run). Throws only when the file cannot be written.
   */
  note(serverKeyId: string, raw: unknown): boolean {
    if (!SERVER_KEY_ID.test(serverKeyId) || !this.#saved(serverKeyId)) return false;
    const parsed = updateChannelWelcomeSchema.safeParse(raw);
    if (!parsed.success || !isUpdateChannelUrl(parsed.data.url)) return false;
    const url = parsed.data.url;
    const before = this.latest()?.url ?? null;
    const previous = this.#channels.get(serverKeyId);
    if (previous === undefined && this.#channels.size >= MAX_UPDATE_CHANNELS) return false;
    const now = this.#now();
    this.#channels.set(serverKeyId, { url, seenAt: now });
    const latestChanged = (this.latest()?.url ?? null) !== before;
    const urlChanged = previous?.url !== url;
    // A stale on-disk time is refreshed; a repeated URL that is still the latest, within the window, moves its time
    // in memory only. A URL change, a first sighting or a change of the latest is written at once.
    const stale = previous !== undefined && now - previous.seenAt >= SEEN_REFRESH_MS;
    if (urlChanged || previous === undefined || stale || latestChanged) {
      const channels = new Map([...this.#channels].filter(([id]) => this.#saved(id)));
      writeJsonAtomic(this.#path, { version: 1, channels: Object.fromEntries(channels) });
      this.#channels = channels;
    }
    return latestChanged;
  }

  /** The most recently seen channel among the servers `keep` accepts (by default, the saved ones), or null. */
  latest(keep: (serverKeyId: string) => boolean = this.#saved): SeenChannel | null {
    let best: SeenChannel | null = null;
    for (const [serverKeyId, entry] of this.#channels) {
      if (!keep(serverKeyId)) continue;
      if (best === null || entry.seenAt > best.seenAt) best = entry;
    }
    return best;
  }
}

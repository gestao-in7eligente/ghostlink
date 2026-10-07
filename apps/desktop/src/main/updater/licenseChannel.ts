// The update channel the app forms from a valid registration key (onboarding plan, phase 3): when the owner
// enters the key, /v1/key-info returns the company download code; the app builds the
// company update feed URL from it and remembers it here, in <userData>/license-channel.json (0600). It feeds
// the same one-time cross-grade (updater/crossGrade.ts) as a server's advertised channel. The code is a secret:
// only the formed URL is stored, it never reaches the renderer, and the cross-grade redacts it from logs.
// Nothing here names an edition.
import { join } from 'node:path';
import { z } from 'zod';
import { isDownloadCode, isUpdateChannelUrl, LICENSE_SERVICE_URL } from '@ghostlink/shared';
import { readJsonFile, writeJsonAtomic } from '../files.js';
import type { SeenChannel } from './serverChannel.js';

export const LICENSE_CHANNEL_FILE = 'license-channel.json';

const fileSchema = z.object({
  version: z.literal(1),
  channel: z.object({ url: z.string(), seenAt: z.number().int().nonnegative() }).nullable(),
});

/** The company update feed a download code points at: `<service>/updates/<code>/`. */
export function licenseChannelUrl(code: string, base: string = LICENSE_SERVICE_URL): string {
  return `${base.replace(/\/+$/, '')}/updates/${code}/`;
}

export interface LicenseChannelOptions {
  now?: () => number;
}

/** A single remembered channel (the one formed from this app's registration key), persisted across restarts. */
export class LicenseChannelStore {
  readonly #path: string;
  readonly #now: () => number;
  #channel: SeenChannel | null;

  private constructor(path: string, channel: SeenChannel | null, opts: LicenseChannelOptions) {
    this.#path = path;
    this.#now = opts.now ?? Date.now;
    this.#channel = channel;
  }

  static load(userDataDir: string, opts: LicenseChannelOptions = {}): LicenseChannelStore {
    const path = join(userDataDir, LICENSE_CHANNEL_FILE);
    const file = readJsonFile(path, fileSchema, (): z.infer<typeof fileSchema> => ({ version: 1, channel: null }));
    // A damaged URL drops the entry rather than quarantining the file.
    const channel = file.channel && isUpdateChannelUrl(file.channel.url) ? { url: file.channel.url, seenAt: file.channel.seenAt } : null;
    return new LicenseChannelStore(path, channel, opts);
  }

  /**
   * Remembers the channel formed from a valid download code. A code that is not one, or that forms a URL the app
   * cannot use, is ignored. Returns true when the stored URL changed (a cross-grade may run). Throws only when the
   * file cannot be written.
   */
  set(code: string): boolean {
    if (!isDownloadCode(code)) return false;
    const url = licenseChannelUrl(code);
    if (!isUpdateChannelUrl(url)) return false;
    const changed = this.#channel?.url !== url;
    this.#channel = { url, seenAt: this.#now() };
    writeJsonAtomic(this.#path, { version: 1, channel: this.#channel });
    return changed;
  }

  /** The channel formed from the key, or null. */
  latest(): SeenChannel | null {
    return this.#channel;
  }
}

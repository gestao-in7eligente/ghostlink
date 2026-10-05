import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { LIMITS, ProtocolError, avatarHashSchema, formatHostPort, parseHostPort, sanitizeLabel } from '@ghostlink/shared';
import {
  DEFAULT_NOTIFY_MODE,
  MAX_CHANNEL_PREFS,
  NOTIFY_MODES,
  type ChannelPrefs,
  type ChannelPrefsPatch,
  type NotifyMode,
  type SavedServer,
} from '../shared/ipcTypes.js';
import { readJsonFile, writeJsonAtomic } from './files.js';

export type { SavedServer } from '../shared/ipcTypes.js';

export const SERVERS_FILE = 'servers.json';
const NAME_MAX_GRAPHEMES = 64;

/** A channel id (entityIdSchema): 128 random bits in base32. */
export const CHANNEL_ID = /^[A-Z2-7]{26}$/;
const channelIdSchema = z.string().regex(CHANNEL_ID);

const channelPrefsSchema = z.object({
  notify: z.enum(NOTIFY_MODES).optional().catch(undefined),
  mutedUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional().catch(undefined),
});

function canonicalAddress(address: string): string {
  const { host, port } = parseHostPort(address.trim());
  return formatHostPort(host, port);
}

const savedServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(256),
  addresses: z.array(z.string().max(262)).min(1).max(LIMITS.inviteMaxAddresses),
  serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nickname: z.string().max(256),
  addedAt: z.number().int().nonnegative(),
  // A damaged hash is no icon, not a damaged file.
  iconHash: avatarHashSchema.optional().catch(undefined),
  // v0.4.2; an unknown mode (a newer app's) reads as the default.
  notify: z.enum(NOTIFY_MODES).optional().catch(undefined),
  // v0.5.0, the channel menu: damaged choices are none, not a damaged file.
  channels: z
    .record(channelIdSchema, channelPrefsSchema)
    .refine((r) => Object.keys(r).length <= MAX_CHANNEL_PREFS)
    .optional()
    .catch(undefined),
  pinned: z.array(channelIdSchema).max(MAX_CHANNEL_PREFS).optional().catch(undefined),
});

const fileSchema = z.object({ version: z.literal(1), servers: z.array(savedServerSchema).max(1000) });

export interface SavedServerInput {
  serverKeyId: string;
  name: string;
  addresses: string[];
  nickname: string;
}

/**
 * `<userData>/servers.json`: the servers this identity joined (one entry per
 * serverKeyId). Addresses are canonical `host:port`; the most recently working
 * ones come first, at most LIMITS.inviteMaxAddresses.
 */
export class SavedServersStore {
  readonly #path: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  #servers: SavedServer[];

  private constructor(path: string, servers: SavedServer[], now: () => number, newId: () => string) {
    this.#path = path;
    this.#servers = servers;
    this.#now = now;
    this.#newId = newId;
  }

  static load(userDataDir: string, opts: { now?: () => number; newId?: () => string } = {}): SavedServersStore {
    const path = join(userDataDir, SERVERS_FILE);
    const file = readJsonFile(path, fileSchema, () => ({ version: 1 as const, servers: [] }));
    return new SavedServersStore(path, file.servers, opts.now ?? Date.now, opts.newId ?? randomUUID);
  }

  list(): SavedServer[] {
    return this.#servers.map(copy);
  }

  get(id: string): SavedServer | undefined {
    const found = this.#servers.find((s) => s.id === id);
    return found && copy(found);
  }

  findByServerKeyId(serverKeyId: string): SavedServer | undefined {
    const found = this.#servers.find((s) => s.serverKeyId === serverKeyId);
    return found && copy(found);
  }

  /**
   * Adds the server, or updates the entry with the same serverKeyId (same id and
   * addedAt; new addresses first, then the known ones). Throws ProtocolError('BAD_REQUEST')
   * on an invalid address or serverKeyId.
   */
  upsert(input: SavedServerInput): SavedServer {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.serverKeyId)) throw new ProtocolError('BAD_REQUEST', 'invalid serverKeyId');
    const existing = this.#servers.find((s) => s.serverKeyId === input.serverKeyId);
    const addresses: string[] = [];
    for (const a of [...input.addresses.map(canonicalAddress), ...(existing?.addresses ?? [])]) {
      if (!addresses.includes(a)) addresses.push(a);
    }
    if (addresses.length === 0) throw new ProtocolError('BAD_REQUEST', 'a server needs an address');
    const entry: SavedServer = {
      id: existing?.id ?? this.#newId(),
      name: sanitizeLabel(input.name, NAME_MAX_GRAPHEMES) || addresses[0]!,
      addresses: addresses.slice(0, LIMITS.inviteMaxAddresses),
      serverKeyId: input.serverKeyId,
      nickname: input.nickname,
      addedAt: existing?.addedAt ?? this.#now(),
      ...(existing?.iconHash === undefined ? {} : { iconHash: existing.iconHash }),
      ...(existing?.notify === undefined ? {} : { notify: existing.notify }),
      ...(existing?.channels === undefined ? {} : { channels: existing.channels }),
      ...(existing?.pinned === undefined ? {} : { pinned: existing.pinned }),
    };
    const next = existing ? this.#servers.map((s) => (s === existing ? entry : s)) : [...this.#servers, entry];
    this.#save(next);
    return copy(entry);
  }

  /**
   * The server icon this app last saw for the saved server `id` (welcome or server.updated);
   * null: initials. Returns true when it changed (and was written).
   */
  setIcon(id: string, hash: string | null): boolean {
    const existing = this.#servers.find((s) => s.id === id);
    if (!existing || (existing.iconHash ?? null) === hash) return false;
    const { iconHash: _previous, ...rest } = existing;
    const entry: SavedServer = hash === null ? rest : { ...rest, iconHash: hash };
    this.#save(this.#servers.map((s) => (s === existing ? entry : s)));
    return true;
  }

  /**
   * Which of the saved server `id`'s messages raise a notification. The default is not written down
   * (the entry looks as it always did). Returns true when it changed (and was written).
   */
  setNotify(id: string, mode: NotifyMode): boolean {
    const existing = this.#servers.find((s) => s.id === id);
    if (!existing || (existing.notify ?? DEFAULT_NOTIFY_MODE) === mode) return false;
    const { notify: _previous, ...rest } = existing;
    const entry: SavedServer = mode === DEFAULT_NOTIFY_MODE ? rest : { ...rest, notify: mode };
    this.#save(this.#servers.map((s) => (s === existing ? entry : s)));
    return true;
  }

  /**
   * One text channel's choices on this computer (channel menu, v0.5.0): its notification mode, its mute
   * and its pin. Nothing is written for what is the default, and mutes already over are dropped on the
   * way. Returns true when it changed (and was written); false for an unknown id. Throws
   * ProtocolError('BAD_REQUEST') past MAX_CHANNEL_PREFS channels.
   */
  setChannel(id: string, channelId: string, patch: ChannelPrefsPatch): boolean {
    if (!CHANNEL_ID.test(channelId)) throw new ProtocolError('BAD_REQUEST', 'invalid channel id');
    const existing = this.#servers.find((s) => s.id === id);
    if (!existing) return false;
    const now = this.#now();
    const channels: Record<string, ChannelPrefs> = {};
    for (const [key, prefs] of Object.entries(existing.channels ?? {})) channels[key] = { ...prefs };
    const prefs: ChannelPrefs = Object.hasOwn(channels, channelId) ? channels[channelId]! : {};
    if (patch.notify === null) delete prefs.notify;
    else if (patch.notify !== undefined) prefs.notify = patch.notify;
    if (patch.mutedUntil === false) delete prefs.mutedUntil;
    else if (patch.mutedUntil !== undefined) prefs.mutedUntil = patch.mutedUntil;
    channels[channelId] = prefs;
    for (const [key, value] of Object.entries(channels)) {
      if (typeof value.mutedUntil === 'number' && value.mutedUntil <= now) delete value.mutedUntil;
      if (value.notify === undefined && value.mutedUntil === undefined) delete channels[key];
    }
    // A new pin goes after the others (pin order); pinning a pinned channel keeps its place.
    const before = existing.pinned ?? [];
    let pinned = before;
    if (patch.pinned === true && !before.includes(channelId)) pinned = [...before, channelId];
    else if (patch.pinned === false) pinned = before.filter((c) => c !== channelId);
    if (Object.keys(channels).length > MAX_CHANNEL_PREFS || pinned.length > MAX_CHANNEL_PREFS) {
      throw new ProtocolError('BAD_REQUEST', 'too many channel choices');
    }
    const { channels: _channels, pinned: _pinned, ...rest } = existing;
    const entry: SavedServer = {
      ...rest,
      ...(Object.keys(channels).length === 0 ? {} : { channels }),
      ...(pinned.length === 0 ? {} : { pinned }),
    };
    if (JSON.stringify(channels) === JSON.stringify(existing.channels ?? {}) && JSON.stringify(pinned) === JSON.stringify(before)) return false;
    this.#save(this.#servers.map((s) => (s === existing ? entry : s)));
    return true;
  }

  /** Returns false when no server has this id. */
  remove(id: string): boolean {
    const next = this.#servers.filter((s) => s.id !== id);
    if (next.length === this.#servers.length) return false;
    this.#save(next);
    return true;
  }

  #save(servers: SavedServer[]): void {
    writeJsonAtomic(this.#path, { version: 1, servers });
    this.#servers = servers;
  }
}

function copy(s: SavedServer): SavedServer {
  const out: SavedServer = { ...s, addresses: [...s.addresses] };
  if (s.channels) out.channels = Object.fromEntries(Object.entries(s.channels).map(([id, prefs]) => [id, { ...prefs }]));
  if (s.pinned) out.pinned = [...s.pinned];
  return out;
}

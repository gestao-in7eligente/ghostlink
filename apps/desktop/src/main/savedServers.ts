import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { LIMITS, ProtocolError, avatarHashSchema, formatHostPort, parseHostPort, sanitizeLabel } from '@ghostlink/shared';
import { DEFAULT_NOTIFY_MODE, NOTIFY_MODES, type NotifyMode, type SavedServer } from '../shared/ipcTypes.js';
import { readJsonFile, writeJsonAtomic } from './files.js';

export type { SavedServer } from '../shared/ipcTypes.js';

export const SERVERS_FILE = 'servers.json';
const NAME_MAX_GRAPHEMES = 64;

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
  return { ...s, addresses: [...s.addresses] };
}

import { join } from 'node:path';
import { z } from 'zod';
import { RAILWAY_REGIONS, RAILWAY_STEPS } from '../../shared/railwayTypes.js';
import { readJsonFile, writeJsonAtomic } from '../files.js';

export const RAILWAY_FILE = 'railway.json';

const id = z.string().min(1).max(128);

/**
 * An unfinished provisioning: what resume() needs to go on and discard() needs to clean up.
 * Written once the project exists. Never the token, never the setup code.
 */
const pendingSchema = z.object({
  workspaceId: id,
  name: z.string().min(1).max(256),
  region: z.enum(RAILWAY_REGIONS),
  nickname: z.string().min(1).max(256),
  /** The server's image choice; a record written before this field existed loads as 'normal'. */
  edition: z.enum(['normal', 'private']).default('normal'),
  /** The last step that completed. */
  completed: z.enum(RAILWAY_STEPS),
  projectId: id,
  environmentId: id,
  serviceId: id.optional(),
  volumeId: id.optional(),
  domain: z.string().min(1).max(253).optional(),
  proxyPort: z.number().int().min(1).max(65535).optional(),
  deploymentId: id.optional(),
  createdAt: z.number().int().nonnegative(),
});

/** A server this app created and joined: the app keeps it on its own version (spec 2026-10-01 §3). */
const managedSchema = z.object({
  projectId: id,
  environmentId: id,
  serviceId: id,
  volumeId: id,
  address: z.string().min(1).max(262),
  serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  region: z.enum(RAILWAY_REGIONS),
  createdAt: z.number().int().nonnegative(),
  /**
   * When the app first saw the server answer an older version than its own (ms). Optional, so
   * files written before v0.2.2 still load; an older app ignores it (z.object drops unknown keys).
   */
  outdatedSince: z.number().int().nonnegative().optional(),
  /**
   * The owner deleted it (leave/delete spec §3): when it is erased, from `server.deleting` in the
   * local clock (ms). The app deletes the Railway project only once this has passed or the server
   * answers SERVER_DELETED; a restore clears it. Optional, like outdatedSince.
   */
  deletingAt: z.number().int().nonnegative().optional(),
  /**
   * An optional companion service (and its volume) provisioned in the same Railway project next to
   * some managed servers. Both optional, like outdatedSince: files written before this load fine, and
   * a server without a companion simply has neither id.
   */
  companionServiceId: id.optional(),
  companionVolumeId: id.optional(),
  /**
   * Companion services provisioned for this server, keyed by agent (v0.9 roster). The legacy
   * companionServiceId/companionVolumeId above are the first agent's slot, kept for records written before this;
   * new writes go here. Optional, so older files load.
   */
  companions: z.record(z.string().min(1).max(64), z.object({ serviceId: id, volumeId: id.optional() })).optional(),
});

const fileSchema = z.object({ version: z.literal(1), pending: pendingSchema.nullable(), managed: z.array(managedSchema).max(1_000) });

export type PendingRecord = z.infer<typeof pendingSchema>;
export type ManagedServer = z.infer<typeof managedSchema>;
type RailwayFile = z.infer<typeof fileSchema>;

/** `<userData>/railway.json`, written atomically (0600). */
export class RailwayStore {
  readonly #path: string;
  #file: RailwayFile;

  private constructor(path: string, file: RailwayFile) {
    this.#path = path;
    this.#file = file;
  }

  static load(userDataDir: string): RailwayStore {
    const path = join(userDataDir, RAILWAY_FILE);
    return new RailwayStore(path, readJsonFile(path, fileSchema, () => ({ version: 1 as const, pending: null, managed: [] })));
  }

  get pending(): PendingRecord | null {
    return this.#file.pending && { ...this.#file.pending };
  }

  get managed(): ManagedServer[] {
    return this.#file.managed.map((m) => ({ ...m }));
  }

  savePending(pending: PendingRecord): void {
    this.#write({ ...this.#file, pending: pendingSchema.parse(pending) });
  }

  clearPending(): void {
    this.#write({ ...this.#file, pending: null });
  }

  /** Success: the pending record becomes a managed server, in one write. */
  complete(server: ManagedServer): void {
    this.#write({ version: 1, pending: null, managed: [...this.#file.managed, managedSchema.parse(server)] });
  }

  /** Records (a time) or clears (null) when the server was first seen outdated; false when it is not managed. */
  setOutdatedSince(serverKeyId: string, since: number | null): boolean {
    if (!this.#file.managed.some((m) => m.serverKeyId === serverKeyId)) return false;
    const managed = this.#file.managed.map((m) => {
      if (m.serverKeyId !== serverKeyId) return m;
      const { outdatedSince: _previous, ...rest } = m;
      return since === null ? rest : managedSchema.parse({ ...rest, outdatedSince: since });
    });
    this.#write({ ...this.#file, managed });
    return true;
  }

  /** Records (a deadline) or clears (null) the owner's deletion; false when it is not managed. */
  setDeletingAt(serverKeyId: string, at: number | null): boolean {
    const current = this.#file.managed.find((m) => m.serverKeyId === serverKeyId);
    if (!current) return false;
    if ((current.deletingAt ?? null) === at) return true;
    const managed = this.#file.managed.map((m) => {
      if (m.serverKeyId !== serverKeyId) return m;
      const { deletingAt: _previous, ...rest } = m;
      return at === null ? rest : managedSchema.parse({ ...rest, deletingAt: at });
    });
    this.#write({ ...this.#file, managed });
    return true;
  }

  /** Merges one agent's companion service/volume ids for a managed server (persist each as it is made); false when not managed. */
  setCompanion(serverKeyId: string, agent: string, ids: { serviceId?: string; volumeId?: string }): boolean {
    const current = this.#file.managed.find((m) => m.serverKeyId === serverKeyId);
    if (!current) return false;
    const prev = current.companions?.[agent];
    const serviceId = ids.serviceId ?? prev?.serviceId;
    if (serviceId === undefined) return true; // a volume cannot be recorded before the service it belongs to
    const volumeId = ids.volumeId ?? prev?.volumeId;
    const entry = volumeId !== undefined ? { serviceId, volumeId } : { serviceId };
    if (prev && prev.serviceId === entry.serviceId && prev.volumeId === entry.volumeId) return true;
    const companions = { ...(current.companions ?? {}), [agent]: entry };
    const managed = this.#file.managed.map((m) => (m.serverKeyId === serverKeyId ? managedSchema.parse({ ...m, companions }) : m));
    this.#write({ ...this.#file, managed });
    return true;
  }

  /** Forgets a server once its Railway project is gone; false when it was not managed. */
  removeManaged(serverKeyId: string): boolean {
    if (!this.#file.managed.some((m) => m.serverKeyId === serverKeyId)) return false;
    this.#write({ ...this.#file, managed: this.#file.managed.filter((m) => m.serverKeyId !== serverKeyId) });
    return true;
  }

  #write(file: RailwayFile): void {
    writeJsonAtomic(this.#path, file);
    this.#file = file;
  }
}

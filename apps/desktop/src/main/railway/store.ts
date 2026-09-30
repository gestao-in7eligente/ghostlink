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

/** A server this app created and joined, kept for the later update and delete features. */
const managedSchema = z.object({
  projectId: id,
  environmentId: id,
  serviceId: id,
  volumeId: id,
  address: z.string().min(1).max(262),
  serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  region: z.enum(RAILWAY_REGIONS),
  createdAt: z.number().int().nonnegative(),
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

  #write(file: RailwayFile): void {
    writeJsonAtomic(this.#path, file);
    this.#file = file;
  }
}

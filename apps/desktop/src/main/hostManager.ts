// Host mode in the main process (spec §9): one hosted server at a time, run in a
// utility process, with the automatic owner join and the Host panel's commands.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LIMITS, ProtocolError, formatFingerprint, formatHostPort, parseHostPort, sanitizeLabel } from '@ghostlink/shared';
import type { InviteInfo } from '@ghostlink/server';
import { AppError, toAppErrorCode, type AppErrorCode } from '../shared/appErrors.js';
import type {
  HostAddress,
  HostConfig,
  HostInvite,
  HostInviteOptions,
  HostNetwork,
  HostStartResult,
  HostState,
  HostStatus,
} from '../shared/hostTypes.js';
import type { JoinConnectRequest, RendererWelcome } from '../shared/ipcTypes.js';
import { readJsonFile, writeJsonAtomic } from './files.js';
import type { ForkServerOptions, ForkedServer } from './hostProcess.js';
import type { HostedStatus } from './hostedServer.js';
import { LineRing } from './hostLogs.js';
import { serverKeyIdFromCertificate } from './pinning.js';

/** `<userData>/hosted/`: one data dir per server slug, plus host.json. */
export const HOSTED_DIR = 'hosted';
export const HOST_FILE = 'host.json';
/** Where the server writes these inside its data dir (apps/server config/paths.ts). */
export const SETUP_CODE_FILE = 'setup-code.txt';
export const SERVER_CERT_FILE = ['tls', 'server.crt'] as const;

export const HOST_NAME_MAX_GRAPHEMES = 64;
export const HOST_PORT_MIN = 1024;
export const HOST_MAX_MEMBERS = 10_000;
const SLUG_MAX = 40;
const SETUP_CODE = /^[0-9a-f]{8}(?:-[0-9a-f]{8}){3}$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

const configSchema = z.strictObject({
  name: z.string().min(1).max(256),
  port: z.number().int().min(HOST_PORT_MIN).max(65535),
  joinMode: z.enum(['invite', 'open']),
  maxMembers: z.number().int().min(1).max(HOST_MAX_MEMBERS),
});

/** The owner deleted the server hosted here (leave/delete spec §3): its data dir goes at `at` (local ms). */
const deletingSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  at: z.number().int().nonnegative(),
});

const fileSchema = z.object({
  version: z.literal(1),
  last: configSchema.nullable(),
  trayNoticeShown: z.boolean(),
  /** Optional: files written before v0.2.4 have none (and an older app drops it). */
  deleting: deletingSchema.nullable().optional(),
});
type HostFile = z.infer<typeof fileSchema>;

/**
 * The data-dir name for a server name: ASCII letters, digits and single dashes,
 * never "..", a separator or a reserved Windows device name.
 */
export function hostSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  if (slug === '') return 'server';
  return WINDOWS_RESERVED.test(slug) ? `${slug}-server` : slug;
}

/** Validates the form (again: the IPC schema is the first gate) and sanitizes the name. */
export function normalizeHostConfig(input: HostConfig): HostConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new ProtocolError('BAD_REQUEST', 'invalid host settings');
  const name = sanitizeLabel(parsed.data.name, HOST_NAME_MAX_GRAPHEMES);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'the server needs a name');
  return { ...parsed.data, name };
}

/** The pending setup code, or null once it was used (the server deletes the file). */
function readSetupCode(dataDir: string): string | null {
  const path = join(dataDir, SETUP_CODE_FILE);
  if (!existsSync(path) || statSync(path).size > 1_024) return null;
  const code = readFileSync(path, 'utf8').trim();
  return SETUP_CODE.test(code) ? code : null;
}

/** The pin, from the certificate the server generated in its own data dir (spec §3.2). */
function readServerKeyId(dataDir: string): string {
  return serverKeyIdFromCertificate(readFileSync(join(dataDir, ...SERVER_CERT_FILE), 'utf8'));
}

/** The pin of a server hosted here before, or null when its data dir has no readable certificate. */
function knownServerKeyId(dataDir: string): string | null {
  if (!existsSync(join(dataDir, ...SERVER_CERT_FILE))) return null;
  try {
    return readServerKeyId(dataDir);
  } catch {
    return null;
  }
}

function errnoOf(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function suggestedPortOf(e: unknown): number | null {
  const port = typeof e === 'object' && e !== null ? (e as { suggestedPort?: unknown }).suggestedPort : undefined;
  return typeof port === 'number' && Number.isInteger(port) && port >= HOST_PORT_MIN && port <= 65535 ? port : null;
}

/** The renderer's view of the server's `net` status (spec §8.5). */
function networkOf(info: HostedStatus | null): HostNetwork | null {
  if (!info?.net) return null;
  const { upnp, cgnat, nodeIp, localAddresses } = info.net;
  return {
    upnp: {
      state: upnp.state,
      wanIp: upnp.wanIp,
      mappings: upnp.mappings.map((m) => (m.ok ? { protocol: m.protocol, port: m.port, ok: true } : { protocol: m.protocol, port: m.port, ok: false, error: m.error })),
    },
    cgnat,
    nodeIp,
    lanIp: (localAddresses.length > 0 ? localAddresses : info.localAddresses).find((l) => l.kind === 'lan')?.ip ?? null,
  };
}

export interface HostManagerDeps {
  userDataDir: string;
  fork(opts: ForkServerOptions): Promise<ForkedServer>;
  /** The client's join (ClientController.join), used for the automatic owner join. */
  join(req: JoinConnectRequest): Promise<RendererWelcome>;
  /** Disconnects the client if it is connected to this server (before a stop). */
  leave(serverKeyId: string): Promise<void>;
  /** The global nickname (settings). */
  nickname(): string;
  /** Every status change, for the renderer and the tray. */
  emit(status: HostStatus): void;
  /** spec §9: 0.0.0.0. Only a dev/test hook may pass loopback. */
  bindHost?: string;
  now?: () => number;
}

/**
 * The hosted server's lifecycle: stopped → starting → running → stopping → stopped,
 * or failed when it cannot start or dies. start/stop/restart/join/recoverOwnership
 * never overlap (HOST_BUSY); invite, refresh and logs can run at any time.
 */
export class HostManager {
  readonly #deps: HostManagerDeps;
  readonly #filePath: string;
  readonly #logs = new LineRing();
  #file: HostFile;
  #state: HostState = 'stopped';
  #config: HostConfig | null;
  #op: Promise<unknown> | null = null;
  #revision = 0;
  #server: ForkedServer | null = null;
  #dataDir: string | null = null;
  /**
   * The pin of the server in the last config's data dir: read at load and kept after a stop
   * (leave/delete spec §6), so the server list recognizes it by key, never by name.
   */
  #serverKeyId: string | null = null;
  #port: number | null = null;
  #info: HostedStatus | null = null;
  #error: AppErrorCode | null = null;
  #errorPort: number | null = null;
  #suggestedPort: number | null = null;
  #joinError: AppErrorCode | null = null;
  #invite: HostInvite | null = null;
  #startedAt: number | null = null;

  constructor(deps: HostManagerDeps) {
    this.#deps = deps;
    this.#filePath = join(deps.userDataDir, HOSTED_DIR, HOST_FILE);
    this.#file = readJsonFile(this.#filePath, fileSchema, () => ({ version: 1 as const, last: null, trayNoticeShown: false, deleting: null }));
    this.#config = this.#file.last;
    if (this.#config) this.#serverKeyId = knownServerKeyId(this.#dataDirOf(this.#config));
  }

  /** starting, running or stopping: closing the window must not end the app (spec §9). */
  isActive(): boolean {
    return this.#state === 'starting' || this.#state === 'running' || this.#state === 'stopping';
  }

  status(): HostStatus {
    return {
      revision: this.#revision,
      state: this.#state,
      config: this.#config && { ...this.#config },
      port: this.#port,
      serverKeyId: this.#serverKeyId,
      fingerprint: this.#serverKeyId && formatFingerprint(this.#serverKeyId),
      addresses: this.#addresses(),
      members: this.#info?.members ?? null,
      maxMembers: this.#info?.maxMembers ?? null,
      hasOwner: this.#info?.hasOwner ?? null,
      error: this.#error,
      errorPort: this.#errorPort,
      suggestedPort: this.#suggestedPort,
      joinError: this.#joinError,
      invite: this.#invite && { ...this.#invite },
      startedAt: this.#startedAt,
      network: networkOf(this.#info),
      busyMediaPorts: [...(this.#info?.busyMediaPorts ?? [])],
    };
  }

  logs(): string[] {
    return this.#logs.lines();
  }

  trayNoticeShown(): boolean {
    return this.#file.trayNoticeShown;
  }

  markTrayNoticeShown(): void {
    this.#save({ ...this.#file, trayNoticeShown: true });
  }

  start(input: HostConfig): Promise<HostStartResult> {
    const config = normalizeHostConfig(input);
    return this.#exclusive(async () => {
      if (this.#server) throw new AppError('HOST_BUSY', 'a server is already hosted');
      await this.#launch(config);
      return this.#afterLaunch();
    });
  }

  stop(): Promise<HostStatus> {
    return this.#exclusive(async () => {
      if (this.#server) {
        const serverKeyId = this.#serverKeyId!;
        this.#state = 'stopping';
        this.#emit();
        try {
          await this.#deps.leave(serverKeyId);
        } catch {
          // Leaving is a courtesy: the server closes every session anyway.
        }
        await this.#shutdown();
      }
      this.#state = 'stopped';
      this.#error = null;
      this.#errorPort = null;
      this.#suggestedPort = null;
      this.#emit();
      return this.status();
    });
  }

  /** "Sair" (spec §9): waits for a start/restart in progress, then stops. Never fails with HOST_BUSY. */
  async stopForQuit(): Promise<void> {
    while (this.#op) await this.#op.catch(() => {});
    await this.stop();
  }

  /** spec §9: "Reiniciar" is shutdown + a new fork (also relaunches a crashed server). */
  restart(): Promise<HostStartResult> {
    return this.#exclusive(async () => {
      const config = this.#config;
      if (config === null || (this.#state !== 'running' && this.#state !== 'failed')) throw new AppError('HOST_NOT_RUNNING');
      if (this.#server) {
        this.#state = 'stopping';
        this.#emit();
        await this.#shutdown();
      }
      await this.#launch(config);
      return this.#afterLaunch();
    });
  }

  join(): Promise<HostStartResult> {
    return this.#exclusive(async () => {
      this.#requireRunning();
      const welcome = await this.#autoJoin();
      return { status: this.status(), welcome };
    });
  }

  /** "Recuperar posse" (spec §3.3): reset-owner in the server, then join with the new code. */
  recoverOwnership(): Promise<HostStartResult> {
    return this.#exclusive(async () => {
      const server = this.#requireRunning();
      const { setupCode } = await server.request<{ setupCode: string }>({ cmd: 'reset-owner' });
      const welcome = await this.#autoJoin(setupCode);
      return { status: this.status(), welcome };
    });
  }

  async invite(opts: HostInviteOptions): Promise<HostInvite> {
    const server = this.#requireRunning();
    const info = await server.request<InviteInfo>({ cmd: 'invite', ...opts });
    if (this.#server !== server) throw new AppError('HOST_NOT_RUNNING');
    this.#invite = {
      code: info.code,
      link: info.link,
      pasteCode: info.pasteCode,
      webLink: info.webLink,
      maxUses: opts.maxUses ?? null,
      expiresInHours: opts.expiresInHours ?? null,
      createdAt: this.#now(),
    };
    this.#emit();
    return { ...this.#invite };
  }

  /**
   * Leave/delete spec §3: the owner deleted the server hosted here, which is erased at `at` (local
   * ms); null after a restore. Only the server in the last config's data dir, recognized by its key.
   * Returns false when `serverKeyId` is not that server.
   */
  markDeleting(serverKeyId: string, at: number | null): boolean {
    const deleting = this.#file.deleting ?? null;
    if (at === null) {
      if (deleting?.serverKeyId !== serverKeyId) return false;
      this.#save({ ...this.#file, deleting: null });
      return true;
    }
    if (this.#config === null || this.#serverKeyId !== serverKeyId) return false;
    if (deleting?.serverKeyId === serverKeyId && deleting.at === at) return true;
    this.#save({ ...this.#file, deleting: { slug: hostSlug(this.#config.name), serverKeyId, at } });
    return true;
  }

  /** The deletion of the server hosted here, if the owner deleted it. */
  deleting(): { serverKeyId: string; at: number } | null {
    const deleting = this.#file.deleting ?? null;
    return deleting && { serverKeyId: deleting.serverKeyId, at: deleting.at };
  }

  /**
   * Leave/delete spec §3: once the deadline passed (or the server answered SERVER_DELETED), the
   * hosted server stops and `hosted/<slug>` is deleted; "Iniciar" is no longer offered for it.
   * Returns the erased server's key, or null when nothing was due (or the folder is still busy:
   * the next sweep tries again).
   */
  async eraseIfDue(now: number, confirmedDeleted: ReadonlySet<string> = new Set()): Promise<string | null> {
    // A running server tells its own state (same computer, same clock): deleting, restored or erased.
    if (this.#state === 'running') await this.#refreshInfo();
    const deleting = this.#file.deleting ?? null;
    const erasedByServer = this.#info?.deleted === true && deleting?.serverKeyId === this.#serverKeyId;
    if (!deleting || (now < deleting.at && !confirmedDeleted.has(deleting.serverKeyId) && !erasedByServer)) return null;
    const current = this.#config !== null && hostSlug(this.#config.name) === deleting.slug;
    if (current && this.isActive()) await this.stopForQuit();
    try {
      rmSync(join(this.#deps.userDataDir, HOSTED_DIR, deleting.slug), { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      this.#logs.push(`[GhostLink] could not delete the deleted server's folder yet: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const last = this.#file.last && hostSlug(this.#file.last.name) === deleting.slug ? null : this.#file.last;
    this.#save({ ...this.#file, last, deleting: null });
    if (current) {
      this.#config = last;
      this.#serverKeyId = null;
      this.#state = 'stopped';
      this.#error = null;
      this.#errorPort = null;
      this.#suggestedPort = null;
    }
    this.#logs.push(`[GhostLink] the deleted server's data (hosted/${deleting.slug}) was erased`);
    this.#emit();
    return deleting.serverKeyId;
  }

  /** Asks the running server for members and addresses (the Host panel polls this). */
  async refresh(): Promise<HostStatus> {
    if (this.#state === 'running' && (await this.#refreshInfo())) this.#emit();
    return this.status();
  }

  async #launch(config: HostConfig): Promise<void> {
    const dataDir = this.#dataDirOf(config);
    mkdirSync(dataDir, { recursive: true });
    this.#config = config;
    this.#save({ ...this.#file, last: config });
    this.#resetRunning();
    this.#serverKeyId = knownServerKeyId(dataDir); // another name is another data dir (or a new one)
    this.#state = 'starting';
    this.#error = null;
    this.#errorPort = null;
    this.#suggestedPort = null;
    this.#emit();
    this.#logs.push(`[GhostLink] starting "${config.name}" on port ${config.port}`);

    let server: ForkedServer;
    try {
      server = await this.#deps.fork({
        dataDir,
        port: config.port,
        host: this.#deps.bindHost ?? '0.0.0.0',
        // spec §9: UPnP is always on in Host mode (the server skips it on a loopback bind).
        args: ['--upnp', `--name=${config.name}`, `--join-mode=${config.joinMode}`, `--max-members=${config.maxMembers}`],
        onLog: (text) => this.#logs.write(text),
      });
    } catch (e) {
      this.#logs.push(`[GhostLink] the server did not start: ${e instanceof Error ? e.message : String(e)}`);
      const busy = errnoOf(e) === 'EADDRINUSE';
      this.#fail(busy ? 'PORT_IN_USE' : 'HOST_FAILED', config.port);
      if (busy) {
        this.#suggestedPort = suggestedPortOf(e);
        this.#emit();
      }
      return;
    }

    try {
      this.#serverKeyId = readServerKeyId(dataDir);
    } catch (e) {
      this.#logs.push(`[GhostLink] cannot read the server certificate: ${e instanceof Error ? e.message : String(e)}`);
      await server.shutdown();
      this.#serverKeyId = null;
      this.#fail('HOST_FAILED', null);
      return;
    }
    this.#server = server;
    this.#dataDir = dataDir;
    this.#port = server.port;
    this.#startedAt = this.#now();
    this.#state = 'running';
    void server.exited.then((code) => this.#onExit(server, code));
    await this.#refreshInfo();
    this.#emit();
  }

  async #afterLaunch(): Promise<HostStartResult> {
    if (this.#state !== 'running') return { status: this.status(), welcome: null };
    const welcome = await this.#autoJoin();
    return { status: this.status(), welcome };
  }

  /**
   * spec §9: the app reads the setup code locally and connects to 127.0.0.1 with
   * the freshly generated pin. Without a code (the server already has an owner)
   * this is a plain member re-entry. Works even when nothing else is reachable.
   */
  async #autoJoin(setupCode: string | null = readSetupCode(this.#dataDir!)): Promise<RendererWelcome | null> {
    const addresses = [formatHostPort('127.0.0.1', this.#port!)];
    for (const a of this.#info?.publicAddresses ?? []) if (!addresses.includes(a)) addresses.push(a);
    const request: JoinConnectRequest = {
      addresses: addresses.slice(0, LIMITS.inviteMaxAddresses),
      serverKeyId: this.#serverKeyId!,
      nickname: this.#deps.nickname(),
      name: this.#config!.name,
    };
    if (setupCode !== null) request.setupCode = setupCode;
    try {
      const welcome = await this.#deps.join(request);
      this.#joinError = null;
      await this.#refreshInfo(); // now with an owner and one more member
      this.#emit();
      return welcome;
    } catch (e) {
      this.#joinError = toAppErrorCode(e);
      this.#logs.push(`[GhostLink] automatic owner join failed: ${this.#joinError}`);
      this.#emit();
      return null;
    }
  }

  /** Returns true when the server answered. */
  async #refreshInfo(): Promise<boolean> {
    const server = this.#server;
    if (!server) return false;
    try {
      const info = await server.request<HostedStatus>({ cmd: 'status' });
      if (this.#server !== server) return false;
      this.#info = info;
      this.#syncDeletion(info);
      return true;
    } catch {
      return false;
    }
  }

  /** The hosted server's own word on its deletion (leave/delete spec §3) keeps host.json's record right. */
  #syncDeletion(info: HostedStatus): void {
    const key = this.#serverKeyId;
    if (key === null) return;
    if (typeof info.deletingAt === 'number') this.markDeleting(key, info.deletingAt);
    else if (info.deleted === true && this.#file.deleting?.serverKeyId !== key) this.markDeleting(key, this.#now());
    else if (info.deleted !== true && this.#file.deleting?.serverKeyId === key) this.markDeleting(key, null);
  }

  #addresses(): HostAddress[] {
    if (this.#port === null) return [];
    const list: HostAddress[] = [{ address: formatHostPort('127.0.0.1', this.#port), kind: 'loopback' }];
    for (const address of this.#info?.publicAddresses ?? []) {
      let host: string;
      try {
        host = parseHostPort(address).host;
      } catch {
        continue;
      }
      const local = this.#info?.localAddresses.find((l) => l.ip === host);
      list.push(local ? { address, kind: local.kind, interface: local.interface } : { address, kind: 'public' });
    }
    return list;
  }

  #onExit(server: ForkedServer, code: number): void {
    if (this.#server !== server || this.#state === 'stopping') return;
    this.#logs.push(`[GhostLink] the server stopped unexpectedly (exit code ${code})`);
    this.#server = null;
    this.#fail('HOST_FAILED', null);
  }

  async #shutdown(): Promise<void> {
    const server = this.#server;
    if (server) await server.shutdown();
    this.#resetRunning();
  }

  #fail(code: AppErrorCode, port: number | null): void {
    this.#resetRunning();
    this.#state = 'failed';
    this.#error = code;
    this.#errorPort = code === 'PORT_IN_USE' ? port : null;
    this.#emit();
  }

  /** Everything that only exists while a server runs; the pin stays (it belongs to the data dir). */
  #resetRunning(): void {
    this.#server = null;
    this.#dataDir = null;
    this.#port = null;
    this.#info = null;
    this.#invite = null;
    this.#joinError = null;
    this.#startedAt = null;
  }

  #requireRunning(): ForkedServer {
    if (this.#state !== 'running' || !this.#server) throw new AppError('HOST_NOT_RUNNING');
    return this.#server;
  }

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#op) throw new AppError('HOST_BUSY', 'another host operation is running');
    const op = fn();
    this.#op = op;
    try {
      return await op;
    } finally {
      this.#op = null;
    }
  }

  #emit(): void {
    this.#revision++;
    this.#deps.emit(this.status());
  }

  #dataDirOf(config: HostConfig): string {
    return join(this.#deps.userDataDir, HOSTED_DIR, hostSlug(config.name));
  }

  #save(file: HostFile): void {
    mkdirSync(join(this.#deps.userDataDir, HOSTED_DIR), { recursive: true });
    writeJsonAtomic(this.#filePath, file);
    this.#file = file;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}

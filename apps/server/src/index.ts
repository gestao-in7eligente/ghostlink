import type { AddressInfo, Server as NetServer } from 'node:net';
import { LIMITS, ProtocolError, formatHostPort, parseHostPort, sanitizeLabel, type JoinMode } from '@ghostlink/shared';
import { ensureSetupCode, resetSetupCode } from './auth/setupCode.js';
import { ensureDataDirs } from './config/paths.js';
import { coreModule } from './coreModule.js';
import { Db } from './db/database.js';
import { ensureMeta, getMeta, setPublicAddresses } from './db/serverMeta.js';
import { deletionState } from './deletion/state.js';
import { createHttpServer } from './http/server.js';
import { buildInviteInfo, createInvite, type InviteInfo } from './invites/invites.js';
import { resolveLimits, type ServerLimits } from './limits.js';
import { consoleLogger, type Logger } from './logger.js';
import type { VoiceServerOptions } from './livekit/backend.js';
import { ModuleHost } from './moduleHost.js';
import type { ProxyEndpoint, ServerModule } from './modules.js';
import { allLocalIPv4, guardAddresses, isWildcardHost, portInUseError, probeTcpPort } from './net/ports.js';
import { createPublicPort } from './net/publicPort.js';
import { PER_ADDRESS, SHARED_ADDRESS } from './ratelimit/limiter.js';
import { loadOrCreateCertificate } from './tls/certificate.js';
import { SERVER_VERSION } from './version.js';
import { Gateway } from './ws/gateway.js';

export type { InviteInfo } from './invites/invites.js';
export type { VoiceServerOptions } from './livekit/backend.js';
export type { Logger } from './logger.js';
export type { ServerLimits } from './limits.js';
export type {
  ModuleContext,
  ModuleOptions,
  ProxyEndpoint,
  RequestContext,
  RequestHandler,
  ServerEvent,
  ServerModule,
  SessionCloseInfo,
  SessionCloseReason,
  SessionInfo,
  SessionsApi,
} from './modules.js';
export { defaultModules, type DefaultModulesOptions } from './defaultModules.js';
export { consoleLogger, silentLogger } from './logger.js';
export { SERVER_VERSION, WEB_SITE_BASE } from './version.js';
export * from './net/addresses.js';
export * from './net/ports.js';
export * from './net/netModule.js';
export { UpnpError, type MappingResult, type UpnpProtocol } from './net/upnp.js';

export interface StartServerOptions {
  dataDir: string; // created if missing
  port: number; // 0 = random (tests)
  host?: string; // default '0.0.0.0'
  name?: string; // used only on first run (seeds server_meta.name)
  publicAddresses?: string[]; // overrides server_meta.public_addresses when given
  joinMode?: JoinMode; // first run only; default 'invite'
  maxMembers?: number; // first run only; default 100 (schema default)
  logger?: Logger;
  now?: () => number; // injectable clock for tests
  limits?: Partial<ServerLimits>; // tests only: shrink timeouts and caps
  modules?: ServerModule[]; // feature modules, run after the built-in 'core' module (see MODULES.md)
  voice?: VoiceServerOptions; // LiveKit binary, public media ports and node_ip (the Hosting track passes node_ip from UPnP)
  /**
   * The external host:port of a TCP proxy in front of this server (spec §8.5 "Atrás de um
   * proxy TCP", e.g. Railway's): the public port then carries HTTPS/WSS and voice (ICE-TCP).
   */
  proxy?: ProxyEndpoint;
}

export interface GhostServer {
  readonly port: number; // actual bound port
  readonly serverKeyId: string;
  readonly version: string;
  readonly dataDir: string;
  setupCode(): string | null; // null once consumed
  createInvite(opts?: { maxUses?: number; expiresInHours?: number; createdBy?: string }): InviteInfo;
  /** Host panel / `status` (spec §9). */
  info(): ServerInfo;
  /** Replaces server_meta.public_addresses (spec §3.5); throws ProtocolError('BAD_REQUEST') on a bad or too long list. */
  setPublicAddresses(addresses: readonly string[]): void;
  /** "Recuperar posse" (spec §3.3): a fresh setup code, written to data/setup-code.txt. */
  resetSetupCode(): string;
  close(): Promise<void>; // graceful: closes WS with SERVER_SHUTDOWN, HTTP, modules (reverse order), DB
}

export interface ServerInfo {
  name: string;
  joinMode: JoinMode;
  maxMembers: number;
  members: number;
  hasOwner: boolean;
  publicAddresses: string[];
  /** The deletion deadline (ms epoch) while the owner's server.delete runs, else null. */
  deletingAt: number | null;
  /** The deadline passed: the data is erased (or about to be) and everyone is refused. */
  deleted: boolean;
}

const MAX_MEMBERS_LIMIT = 100_000;

const DEFAULT_NAME = 'GhostLink';

/** Validates and canonicalizes "host:port" strings; throws ProtocolError('BAD_REQUEST'). */
function normalizeAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    const { host, port } = parseHostPort(a.trim());
    const canonical = formatHostPort(host, port);
    if (!out.includes(canonical)) out.push(canonical);
  }
  if (out.length > LIMITS.inviteMaxAddresses) throw new ProtocolError('BAD_REQUEST', `at most ${LIMITS.inviteMaxAddresses} public addresses`);
  return out;
}

export async function startServer(opts: StartServerOptions): Promise<GhostServer> {
  const logger = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const proxy = opts.proxy === undefined ? undefined : parseHostPort(formatHostPort(opts.proxy.host, opts.proxy.port));
  // spec §13: behind a TCP proxy every client arrives from the proxy's address.
  const limits = resolveLimits(opts.limits, { sharedAddress: proxy !== undefined });
  const addressing = proxy ? SHARED_ADDRESS : PER_ADDRESS;
  if (opts.maxMembers !== undefined && (!Number.isInteger(opts.maxMembers) || opts.maxMembers < 1 || opts.maxMembers > MAX_MEMBERS_LIMIT)) {
    throw new ProtocolError('BAD_REQUEST', `maxMembers must be an integer between 1 and ${MAX_MEMBERS_LIMIT}`);
  }
  // Validates module names and request types before anything touches the disk.
  const modules = new ModuleHost([coreModule, ...(opts.modules ?? [])], logger);
  const host = opts.host ?? '0.0.0.0';
  if (opts.port !== 0) {
    // spec §8.5: a port held by another program on ANY relevant address is busy (see net/ports.ts).
    const probe = await probeTcpPort(opts.port, { bindHost: host });
    if (!probe.free) throw portInUseError(opts.port, host, probe.busyOn);
  }
  const paths = ensureDataDirs(opts.dataDir);
  const certificate = await loadOrCreateCertificate(opts.dataDir);

  const db = new Db(paths.db);
  const isDeleted = (): boolean => deletionState(getMeta(db), now()).phase === 'deleted';
  try {
    db.migrate();
    ensureMeta(db, {
      name: sanitizeLabel(opts.name ?? DEFAULT_NAME, 64) || DEFAULT_NAME,
      joinMode: opts.joinMode ?? 'invite',
      maxMembers: opts.maxMembers,
      now: now(),
    });
    if (opts.publicAddresses !== undefined) setPublicAddresses(db, normalizeAddresses(opts.publicAddresses));
    // A deleted server has no owner left, but nobody may claim it: no setup code.
    if (!isDeleted()) ensureSetupCode(db, opts.dataDir);
  } catch (e) {
    db.close();
    throw e;
  }

  const gateway = new Gateway({
    db,
    dataDir: opts.dataDir,
    serverKeyId: certificate.serverKeyId,
    version: SERVER_VERSION,
    limits,
    now,
    logger,
    modules,
    addressing,
  });
  const http = createHttpServer({
    certPem: certificate.certPem,
    keyPem: certificate.keyPem,
    health: () => ({ name: getMeta(db).name, version: SERVER_VERSION }),
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
    moduleRequest: (req, res) => modules.http(req, res),
    moduleUpgrade: (req, socket, head) => modules.upgrade(req, socket, head),
    limits,
    addressKey: (address) => addressing.keyOf(address),
  });
  // spec §8.5: behind a TCP proxy, one public port for TLS and ICE-TCP, told apart by the first byte.
  const front = proxy ? createPublicPort({ tls: http, iceTarget: () => modules.iceTcpPort(), limits }) : null;
  const listener: NetServer = front?.server ?? http;

  let guards: Array<{ close(cb: () => void): unknown }> = [];
  /** Order matters: sessions end (modules still see onSessionClosed), then HTTP, then modules stop, then the DB. */
  const shutdown = async (): Promise<void> => {
    await Promise.all(guards.map((g) => new Promise<void>((resolve) => g.close(() => resolve()))));
    await gateway.close();
    if (front) {
      // Nothing waits for these sockets: TLS ones already ended their sessions above.
      front.server.close();
      front.destroyAll();
      http.closeAllConnections();
    } else if (http.listening) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    }
    await modules.stop();
    db.close();
  };

  try {
    await modules.init({
      db,
      now,
      logger,
      limits,
      dataDir: opts.dataDir,
      serverKeyId: certificate.serverKeyId,
      sessions: gateway.sessions.api,
      options: { voice: opts.voice, proxy },
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(opts.port, host, () => {
        listener.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    await shutdown();
    throw e;
  }
  const port = (listener.address() as AddressInfo).port;
  if (process.platform === 'win32' && isWildcardHost(host)) {
    // Windows would let another program bind 127.0.0.1:port (or a LAN IP) over our wildcard listener.
    guards = await guardAddresses(listener, port, ['127.0.0.1', ...allLocalIPv4()]);
  }
  try {
    await modules.start({ port });
  } catch (e) {
    await shutdown();
    throw e;
  }
  logger.info('GhostLink server listening', { port, version: SERVER_VERSION });
  if (proxy) {
    logger.info(
      `proxy mode: behind the TCP proxy ${formatHostPort(proxy.host, proxy.port)}; port ${port} carries HTTPS/WSS and voice (ICE-TCP). ` +
        'Every client arrives from the proxy, so the per-IP limits are server-wide: ' +
        `${limits.maxSockets} open sockets, ${limits.maxConnectionsPerIp} unauthenticated connections, ` +
        `${limits.authFailuresPerIpPerMinute} authentication failures per minute (members are never locked out), ` +
        `${limits.newIdentitiesPerIpPerHour} new members per hour; last_ip is not recorded, so IP bans are off`,
    );
  }

  const effectiveAddresses = (): string[] => {
    const stored = getMeta(db).publicAddresses;
    return stored.length > 0 ? stored : [`127.0.0.1:${port}`];
  };

  let closing: Promise<void> | null = null;
  return {
    port,
    serverKeyId: certificate.serverKeyId,
    version: SERVER_VERSION,
    dataDir: opts.dataDir,
    setupCode: () => (isDeleted() ? null : ensureSetupCode(db, opts.dataDir)),
    createInvite: (o = {}) => {
      const { code } = createInvite(db, { ...o, now: now() });
      return buildInviteInfo(code, { addresses: effectiveAddresses(), serverKeyId: certificate.serverKeyId, name: getMeta(db).name });
    },
    info: () => {
      const meta = getMeta(db);
      const members = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL')?.n ?? 0);
      const deletion = deletionState(meta, now());
      return {
        name: meta.name,
        joinMode: meta.joinMode,
        maxMembers: meta.maxMembers,
        members,
        hasOwner: meta.ownerUserId !== null,
        publicAddresses: meta.publicAddresses,
        deletingAt: deletion.phase === 'deleting' ? deletion.at : null,
        deleted: deletion.phase === 'deleted',
      };
    },
    setPublicAddresses: (addresses) => setPublicAddresses(db, normalizeAddresses(addresses)),
    resetSetupCode: () => resetSetupCode(db, opts.dataDir),
    close: () => {
      closing ??= (async () => {
        await shutdown();
        logger.info('GhostLink server stopped');
      })();
      return closing;
    },
  };
}

import type { AddressInfo } from 'node:net';
import { formatHostPort, parseHostPort, sanitizeLabel, type JoinMode } from '@ghostlink/shared';
import { ensureSetupCode } from './auth/setupCode.js';
import { ensureDataDirs } from './config/paths.js';
import { Db } from './db/database.js';
import { ensureMeta, getMeta, setPublicAddresses } from './db/serverMeta.js';
import { createHttpServer } from './http/server.js';
import { buildInviteInfo, createInvite, type InviteInfo } from './invites/invites.js';
import { resolveLimits, type ServerLimits } from './limits.js';
import { consoleLogger, type Logger } from './logger.js';
import { loadOrCreateCertificate } from './tls/certificate.js';
import { SERVER_VERSION } from './version.js';
import { Gateway } from './ws/gateway.js';

export type { InviteInfo } from './invites/invites.js';
export type { Logger } from './logger.js';
export type { ServerLimits } from './limits.js';
export { consoleLogger, silentLogger } from './logger.js';
export { SERVER_VERSION, WEB_SITE_BASE } from './version.js';

export interface StartServerOptions {
  dataDir: string; // created if missing
  port: number; // 0 = random (tests)
  host?: string; // default '0.0.0.0'
  name?: string; // used only on first run (seeds server_meta.name)
  publicAddresses?: string[]; // overrides server_meta.public_addresses when given
  joinMode?: JoinMode; // first run only; default 'invite'
  logger?: Logger;
  now?: () => number; // injectable clock for tests
  limits?: Partial<ServerLimits>; // tests only: shrink timeouts and caps
}

export interface GhostServer {
  readonly port: number; // actual bound port
  readonly serverKeyId: string;
  readonly version: string;
  readonly dataDir: string;
  setupCode(): string | null; // null once consumed
  createInvite(opts?: { maxUses?: number; expiresInHours?: number; createdBy?: string }): InviteInfo;
  close(): Promise<void>; // graceful: closes WS with SERVER_SHUTDOWN, HTTP, DB
}

const DEFAULT_NAME = 'GhostLink';

/** Validates and canonicalizes "host:port" strings; throws ProtocolError('BAD_REQUEST'). */
function normalizeAddresses(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    const { host, port } = parseHostPort(a.trim());
    const canonical = formatHostPort(host, port);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

export async function startServer(opts: StartServerOptions): Promise<GhostServer> {
  const logger = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;
  const limits = resolveLimits(opts.limits);
  const paths = ensureDataDirs(opts.dataDir);
  const certificate = await loadOrCreateCertificate(opts.dataDir);

  const db = new Db(paths.db);
  try {
    db.migrate();
    ensureMeta(db, {
      name: sanitizeLabel(opts.name ?? DEFAULT_NAME, 64) || DEFAULT_NAME,
      joinMode: opts.joinMode ?? 'invite',
      now: now(),
    });
    if (opts.publicAddresses !== undefined) setPublicAddresses(db, normalizeAddresses(opts.publicAddresses));
    ensureSetupCode(db, opts.dataDir);
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
  });
  const http = createHttpServer({
    certPem: certificate.certPem,
    keyPem: certificate.keyPem,
    health: () => ({ name: getMeta(db).name, version: SERVER_VERSION }),
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    await gateway.close();
    db.close();
    throw e;
  }
  const port = (http.address() as AddressInfo).port;
  logger.info('GhostLink server listening', { port, version: SERVER_VERSION });

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
    setupCode: () => ensureSetupCode(db, opts.dataDir),
    createInvite: (o = {}) => {
      const { code } = createInvite(db, { ...o, now: now() });
      return buildInviteInfo(code, { addresses: effectiveAddresses(), serverKeyId: certificate.serverKeyId, name: getMeta(db).name });
    },
    close: () => {
      closing ??= (async () => {
        await gateway.close();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
        db.close();
        logger.info('GhostLink server stopped');
      })();
      return closing;
    },
  };
}

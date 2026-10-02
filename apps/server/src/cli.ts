import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ProtocolError, formatFingerprint, formatHostPort, parseHostPort } from '@ghostlink/shared';
import { ensureSetupCode, resetSetupCode } from './auth/setupCode.js';
import { dataPaths } from './config/paths.js';
import { Db, DatabaseTooNewError } from './db/database.js';
import { getMeta } from './db/serverMeta.js';
import { findFfmpeg } from './ghostDj/ffmpeg.js';
import { GHOST_DJ_DIR, GHOST_DJ_MODULE_NAME, type GhostDjModule } from './ghostDj/index.js';
import { COOKIES_FILE, installedYtdlpVersion } from './ghostDj/ytdlp.js';
import { consoleLogger, defaultModules, startServer } from './index.js';
import { buildInviteInfo, createInvite } from './invites/invites.js';
import { resolveNodeIp } from './net/addresses.js';
import { createNetModule } from './net/netModule.js';
import { findFreeTcpPort } from './net/ports.js';
import type { ProxyEndpoint } from './modules.js';
import { readCertificate } from './tls/certificate.js';
import { SERVER_VERSION } from './version.js';
import type { VoiceModule } from './voice/index.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliOptions {
  /** `start` runs until this settles (default: SIGINT or SIGTERM). Tests resolve it. */
  untilStop?: Promise<void>;
}

/** spec §8.5: LiveKit's public media ports, mapped next to the server's own port with --upnp. */
const MEDIA_PORTS = [
  { protocol: 'UDP' as const, port: 7882 },
  { protocol: 'TCP' as const, port: 7881 },
];

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_PORT_IN_USE = 2; // spec §8.5

const USAGE = `Usage: ghostlink-server <command> [options]

Commands:
  start        Run the server
  invite       Create an invite (works while the server is running)
  setup-code   Print the pending owner setup code
  reset-owner  Issue a new owner setup code (whoever uses it becomes the owner)
  status       Print version, fingerprint and membership summary
  ghost-dj     Check what the Ghost DJ (music bot) needs: ffmpeg, its LiveKit
               audio add-on and, with --data, yt-dlp and cookies.txt
  version      Print the server version

Options:
  --data <dir>               Data directory (default: $GHOSTLINK_DATA)
  --port <n>                 start: TCP port (default 7700, 0 = random)
  --host <address>           start: bind address (default 0.0.0.0)
  --name <text>              start: server name (first run only)
  --public-address <h:p>     start: address to put in invites (repeatable);
                             without it, the addresses are detected
  --node-ip <ipv4>           start: IP announced for voice media (default:
                             the UPnP WAN IP, else a public IP of this
                             machine, else the LAN IP)
  --upnp                     start: open the ports on the router via UPnP
  --proxy <host:port>        start: run behind a TCP proxy (e.g. Railway's)
                             with this external address: HTTPS/WSS and voice
                             (ICE-TCP only) share the port, LiveKit announces
                             the proxy's IPv4 and port, and the per-IP limits
                             become server-wide. It is also the public address
                             unless --public-address is given
  --max-uses <n>             invite: maximum number of uses
  --expires <n>h | <n>d      invite: expiry, e.g. 24h or 7d
  -h, --help                 Show this help`;

class UsageError extends Error {}

const OPTIONS = {
  data: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  name: { type: 'string' },
  'public-address': { type: 'string', multiple: true },
  'node-ip': { type: 'string' },
  upnp: { type: 'boolean' },
  proxy: { type: 'string' },
  'max-uses': { type: 'string' },
  expires: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function dataDirOf(values: Values, env: NodeJS.ProcessEnv): string {
  const dir = values.data ?? env.GHOSTLINK_DATA;
  if (!dir) throw new UsageError('Missing --data <dir> (or set GHOSTLINK_DATA).');
  return resolve(dir);
}

function integer(text: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a whole number.`);
  const n = Number(text);
  if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}.`);
  return n;
}

function hoursOf(text: string): number {
  const m = /^(\d+)([hd])$/.exec(text);
  if (!m) throw new UsageError('--expires must look like 24h or 7d.');
  return Number(m[1]) * (m[2] === 'd' ? 24 : 1);
}

/** Opens an initialized data dir; returns null (after printing why) when there is nothing there. */
function openExisting(dataDir: string, io: CliIo): Db | null {
  if (readCertificate(dataDir) === null) {
    io.err(`No GhostLink server data in ${dataDir}. Run "ghostlink-server start --data ${dataDir}" first.`);
    return null;
  }
  return new Db(dataPaths(dataDir).db);
}

function nodeIpOf(values: Values): string | undefined {
  const ip = values['node-ip'];
  if (ip === undefined) return undefined;
  try {
    resolveNodeIp({ explicit: ip, local: [] });
  } catch {
    throw new UsageError('--node-ip must be an IPv4 address, e.g. 203.0.113.10.');
  }
  return ip;
}

/** --proxy: the proxy's external host:port, with an explicit port (spec §8.6). */
function proxyOf(values: Values): ProxyEndpoint | undefined {
  const text = values.proxy?.trim();
  if (text === undefined) return undefined;
  const bad = new UsageError("--proxy must be the proxy's external host:port, e.g. altaria.proxy.rlwy.net:25889.");
  // The port is the whole point: LiveKit announces it (parseHostPort would default to 7700).
  if (!/^(?:\[[^\]]+\]|[^:]+):\d+$/.test(text)) throw bad;
  try {
    return parseHostPort(text);
  } catch {
    throw bad;
  }
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function cmdStart(values: Values, env: NodeJS.ProcessEnv, io: CliIo, opts: CliOptions): Promise<number> {
  const dataDir = dataDirOf(values, env);
  const port = values.port === undefined ? 7700 : integer(values.port, '--port', 0, 65535);
  const host = values.host ?? '0.0.0.0';
  const nodeIp = nodeIpOf(values);
  const proxy = proxyOf(values);
  // Behind a proxy, the proxy's address is the way in (spec §8.6).
  const publicAddresses = values['public-address'] ?? (proxy ? [formatHostPort(proxy.host, proxy.port)] : undefined);
  // Addresses come from --public-address (spec §10); without it they are detected and kept up to date.
  const net = createNetModule({ upnp: values.upnp === true, manageAddresses: publicAddresses === undefined, bindHost: host, nodeIp, mediaPorts: MEDIA_PORTS });
  const features = defaultModules();
  const voice = features.find((m): m is VoiceModule => m.name === 'voice');
  const ghostDj = features.find((m): m is GhostDjModule => m.name === GHOST_DJ_MODULE_NAME);
  let server;
  try {
    server = await startServer({
      dataDir,
      port,
      host,
      name: values.name,
      publicAddresses,
      logger: consoleLogger,
      // `net` first, so later modules (voice) can read its node IP when they start.
      modules: [net, ...features],
      // spec §8.1: an explicit --node-ip (install.sh passes the VPS's public IP) wins in voice.
      voice: nodeIp === undefined ? undefined : { nodeIp },
      proxy,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const busyOn = (e as { busyOn?: string[] }).busyOn;
      io.err(`Port ${port} is already in use by another program${busyOn?.length ? ` (on ${busyOn.join(', ')})` : ''}.`);
      const next = port === 0 ? null : await findFreeTcpPort(port, { bindHost: host });
      io.err(next === null ? 'Choose another one with --port.' : `The next free port is ${next}: start with --port ${next}.`);
      io.err('Changing the port makes old invites stop working; create new ones afterwards.');
      return EXIT_PORT_IN_USE;
    }
    throw e;
  }
  io.out(`GhostLink server ${server.version}`);
  io.out(`Data directory: ${dataDir}`);
  io.out(`Listening on ${host}:${server.port}`);
  io.out(`Fingerprint: ${formatFingerprint(server.serverKeyId)}`);
  const setupCode = server.setupCode();
  if (setupCode !== null) io.out(`Setup code (use it once to become the owner): ${setupCode}`);
  const report = () => {
    const status = net.status();
    const addresses = server.info().publicAddresses;
    if (proxy) io.out(`Proxy mode: behind ${formatHostPort(proxy.host, proxy.port)} (HTTPS/WSS and voice share port ${server.port}; per-IP limits are server-wide)`);
    io.out(`Public addresses: ${addresses.length > 0 ? addresses.join(', ') : '(none detected; use --public-address host:port)'}`);
    io.out(`Node IP (announced for voice): ${voice?.nodeIp ?? status.nodeIp ?? '(none; use --node-ip)'}`);
    if (status.upnp.state === 'off') {
      io.out('UPnP: off (use --upnp to open the ports on a home router)');
    } else {
      const mapped = status.upnp.mappings.map((m) => `${m.protocol} ${m.port}: ${m.ok ? 'open' : m.error}`).join(', ');
      io.out(`UPnP: ${status.upnp.state}${mapped ? ` (${mapped})` : ''}`);
    }
    if (status.cgnat) io.out('Warning: the router is behind CGNAT or double NAT; people outside your network cannot reach it directly. Use a VPN or a VPS.');
    if (ghostDj) io.out(`Ghost DJ: ${ghostDj.status()}`);
  };
  const stop = opts.untilStop ?? waitForSignal();
  // With --upnp, report once the router answered (or not); never delays a stop request.
  await Promise.race([net.ready(), stop]);
  report();
  await stop;
  io.out('Shutting down…');
  await server.close();
  return EXIT_OK;
}

/** spec §3.3 "Recuperar posse" on a VPS: a fresh setup code; the identity that uses it becomes the owner. */
function cmdResetOwner(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const db = openExisting(dataDir, io);
  if (!db) return EXIT_ERROR;
  try {
    db.migrate();
    const code = resetSetupCode(db, dataDir);
    io.out(`New setup code: ${code}`);
    io.out('Connect with it from the app to become the owner. It works once, even while the server is running.');
    return EXIT_OK;
  } finally {
    db.close();
  }
}

function cmdInvite(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const maxUses = values['max-uses'] === undefined ? undefined : integer(values['max-uses'], '--max-uses', 1, 10_000);
  const expiresInHours = values.expires === undefined ? undefined : hoursOf(values.expires);
  const certificate = readCertificate(dataDir);
  const db = openExisting(dataDir, io);
  if (!db || !certificate) return EXIT_ERROR;
  try {
    db.migrate();
    const meta = getMeta(db);
    if (meta.publicAddresses.length === 0) {
      io.err('No public address configured. Start the server with --public-address <host:port> first.');
      return EXIT_ERROR;
    }
    const { code } = createInvite(db, { maxUses, expiresInHours, now: Date.now() });
    const info = buildInviteInfo(code, { addresses: meta.publicAddresses, serverKeyId: certificate.serverKeyId, name: meta.name });
    io.out(`Invite code: ${info.code}`);
    io.out(`Uses: ${maxUses ?? 'unlimited'}  Expires: ${expiresInHours === undefined ? 'never' : `in ${expiresInHours} h`}`);
    io.out(`Web link (share this): ${info.webLink}`);
    io.out(`App link: ${info.link}`);
    io.out(`Paste code: ${info.pasteCode}`);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

function cmdSetupCode(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const db = openExisting(dataDir, io);
  if (!db) return EXIT_ERROR;
  try {
    db.migrate();
    const code = ensureSetupCode(db, dataDir);
    io.out(code === null ? 'This server already has an owner; there is no pending setup code.' : code);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

function cmdStatus(values: Values, env: NodeJS.ProcessEnv, io: CliIo): number {
  const dataDir = dataDirOf(values, env);
  const certificate = readCertificate(dataDir);
  const db = openExisting(dataDir, io);
  if (!db || !certificate) return EXIT_ERROR;
  try {
    if (db.userVersion === 0) {
      io.err(`The database in ${dataDir} is not initialized. Start the server once first.`);
      return EXIT_ERROR;
    }
    const meta = getMeta(db);
    const members = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL')?.n ?? 0);
    io.out(`GhostLink server ${SERVER_VERSION}`);
    io.out(`Data directory: ${dataDir}`);
    io.out(`Name: ${meta.name}`);
    io.out(`Fingerprint: ${formatFingerprint(certificate.serverKeyId)}`);
    io.out(`Server key ID: ${certificate.serverKeyId}`);
    io.out(`Join mode: ${meta.joinMode}`);
    io.out(`Members: ${members} / ${meta.maxMembers}`);
    io.out(`Owner: ${meta.ownerUserId === null ? 'none yet (setup code pending)' : meta.ownerUserId}`);
    io.out(`Public addresses: ${meta.publicAddresses.length > 0 ? meta.publicAddresses.join(', ') : '(none configured)'}`);
    return EXIT_OK;
  } finally {
    db.close();
  }
}

/** What the Ghost DJ needs on this machine (spec 2026-10-02-ghost-dj-design.md §2). */
async function cmdGhostDj(values: Values, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const ffmpeg = findFfmpeg();
  io.out(`ffmpeg: ${ffmpeg ? 'found' : 'not found (install it: sudo apt install ffmpeg)'}`);
  let audio = false;
  try {
    const { checkLivekitAudio } = await import('./ghostDj/livekitOutput.js');
    await checkLivekitAudio();
    audio = true;
    io.out('LiveKit audio (@livekit/rtc-node): ok');
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0];
    io.out(`LiveKit audio (@livekit/rtc-node): failed (${why})`);
  }
  const data = values.data ?? env.GHOSTLINK_DATA;
  if (data) {
    const dir = join(resolve(data), GHOST_DJ_DIR);
    io.out(`yt-dlp: ${installedYtdlpVersion(dir) ?? 'not downloaded yet (the running server downloads it)'}`);
    io.out(`${GHOST_DJ_DIR}/${COOKIES_FILE}: ${existsSync(join(dir, COOKIES_FILE)) ? 'present' : 'absent (only needed when YouTube blocks this server)'}`);
  }
  return ffmpeg !== null && audio ? EXIT_OK : EXIT_ERROR;
}

/** Entry point of the ghostlink-server command. Output is English (contract §4). */
export async function runCli(argv: string[], io: CliIo = defaultIo, env: NodeJS.ProcessEnv = process.env, opts: CliOptions = {}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...extra] = positionals;
    if (values.help || command === undefined) {
      io.out(USAGE);
      return values.help ? EXIT_OK : EXIT_ERROR;
    }
    if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra[0]}`);
    switch (command) {
      case 'start':
        return await cmdStart(values, env, io, opts);
      case 'invite':
        return cmdInvite(values, env, io);
      case 'reset-owner':
        return cmdResetOwner(values, env, io);
      case 'setup-code':
        return cmdSetupCode(values, env, io);
      case 'status':
        return cmdStatus(values, env, io);
      case 'ghost-dj':
        return await cmdGhostDj(values, env, io);
      case 'version':
        io.out(SERVER_VERSION);
        return EXIT_OK;
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err((e as Error).message);
      io.err('Run "ghostlink-server --help" for usage.');
      return EXIT_ERROR;
    }
    if (e instanceof DatabaseTooNewError || e instanceof ProtocolError) {
      io.err(e.message);
      return EXIT_ERROR;
    }
    io.err(`Unexpected error: ${(e as Error).stack ?? String(e)}`);
    return EXIT_ERROR;
  }
}

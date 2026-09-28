// The `net` server module (spec §3.5, §8.1, §8.5): keeps server_meta.public_addresses
// in step with this machine's addresses, runs UPnP (map the public ports, read the WAN
// IP, renew, unmap on stop) and provides node_ip for LiveKit.
//
// Why a module: the CLI (`start --upnp`) and Host mode share it, and its lifecycle is
// the server's — start() after listen, stop() on close, before the database closes.
// It is not in defaultModules(): callers put it FIRST, with their options:
//   modules: [createNetModule({ upnp, manageAddresses, bindHost, nodeIp }), ...defaultModules()]
// so another module (Voice) can read `ctx.getModule<NetModule>('net').nodeIp()` in its start().
import { setPublicAddresses } from '../db/serverMeta.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { buildPublicAddresses, isCgnatOrPrivate, localIPv4Addresses, resolveNodeIp, type LocalAddress } from './addresses.js';
import { isWildcardHost } from './ports.js';
import { PortMapper, UpnpClient, discoverGateway, type MappingResult, type UpnpGateway, type UpnpProtocol } from './upnp.js';

export const NET_MODULE = 'net';
/** How often the local interfaces are re-read (a new Wi-Fi, a VPN that connects). */
export const NET_REFRESH_MS = 30_000;
/** At most this long, stop() waits for a UPnP search in progress before unmapping. */
const STOP_WAIT_MS = 4_000;

export type UpnpState = 'off' | 'searching' | 'mapped' | 'partial' | 'failed' | 'unavailable';

export interface NetStatus {
  upnp: { state: UpnpState; wanIp: string | null; mappings: MappingResult[] };
  /** The router's WAN IP is itself private or in 100.64/10: CGNAT or double NAT (spec §8.1). */
  cgnat: boolean;
  nodeIp: string | null;
  localAddresses: LocalAddress[];
}

export interface NetModuleOptions {
  /** spec §8.5: always on in Host mode, `--upnp` in the CLI. Never runs when bound to loopback. */
  upnp?: boolean;
  /** Keep public_addresses equal to the detected addresses (Host mode; CLI without --public-address). */
  manageAddresses?: boolean;
  /** The address the server listens on (default 0.0.0.0). */
  bindHost?: string;
  /** Explicit node_ip (CLI --node-ip); else the UPnP WAN when public, else the LAN (spec §8.1). */
  nodeIp?: string;
  /** Ports to map besides the server's own TCP port (LiveKit: 7882/UDP, 7881/TCP). */
  mediaPorts?: Array<{ protocol: UpnpProtocol; port: number }>;
  refreshMs?: number;
  /** Test seams. */
  localAddresses?: () => LocalAddress[];
  discover?: () => Promise<UpnpGateway | null>;
}

export interface NetModule extends ServerModule {
  status(): NetStatus;
  nodeIp(): string | null;
  /** Re-reads the interfaces and updates public_addresses when they changed. */
  refresh(): Promise<NetStatus>;
  /** Resolves once the first UPnP attempt settled (immediately when UPnP is off). */
  ready(): Promise<void>;
}

export function createNetModule(opts: NetModuleOptions = {}): NetModule {
  const bindHost = opts.bindHost ?? '0.0.0.0';
  const readLocal = opts.localAddresses ?? (() => localIPv4Addresses());
  if (opts.nodeIp) resolveNodeIp({ explicit: opts.nodeIp, local: [] }); // validates, throws on a bad value
  const upnpEnabled = opts.upnp === true && !/^127\./.test(bindHost) && bindHost !== 'localhost';

  let ctx: ModuleContext | null = null;
  let port = 0;
  let local: LocalAddress[] = [];
  let upnp: NetStatus['upnp'] = { state: 'off', wanIp: null, mappings: [] };
  let mapper: PortMapper | null = null;
  let client: UpnpClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let work: Promise<void> = Promise.resolve();
  let lastWritten = '';

  /** Local addresses this server is reachable on, given where it listens. */
  const reachable = (): LocalAddress[] => (isWildcardHost(bindHost) ? local : local.filter((l) => l.ip === bindHost));

  const writeAddresses = () => {
    if (!opts.manageAddresses || !ctx) return;
    const next = buildPublicAddresses({ port, wanIp: upnp.wanIp, local: reachable() });
    const key = next.join(',');
    if (key === lastWritten) return;
    lastWritten = key;
    setPublicAddresses(ctx.db, next);
  };

  const nodeIp = () => resolveNodeIp({ explicit: opts.nodeIp, wanIp: upnp.wanIp, local: reachable() });

  const status = (): NetStatus => ({
    upnp: { ...upnp, mappings: upnp.mappings.map((m) => ({ ...m })) },
    cgnat: upnp.wanIp !== null && isCgnatOrPrivate(upnp.wanIp),
    nodeIp: nodeIp(),
    localAddresses: local.map((l) => ({ ...l })),
  });

  const settle = (results: MappingResult[]) => {
    const ok = results.filter((r) => r.ok).length;
    upnp.mappings = results;
    upnp.state = ok === results.length ? 'mapped' : ok > 0 ? 'partial' : 'failed';
  };

  const runUpnp = async () => {
    upnp = { state: 'searching', wanIp: null, mappings: [] };
    const gateway = await (opts.discover ?? (() => discoverGateway()))().catch(() => null);
    if (stopped) return;
    if (!gateway) {
      upnp = { state: 'unavailable', wanIp: null, mappings: [] };
      ctx?.logger.warn('UPnP: no router answered; forward the ports manually or use a VPN');
      return;
    }
    client = new UpnpClient(gateway);
    upnp.wanIp = await client.externalIp().catch(() => null);
    if (stopped) return;
    const ports = [{ protocol: 'TCP' as const, port }, ...(opts.mediaPorts ?? [])];
    mapper = new PortMapper({
      client,
      ports,
      onRenew: (results) => {
        settle(results);
        void client
          ?.externalIp()
          .then((ip) => {
            upnp.wanIp = ip;
            writeAddresses();
          })
          .catch(() => {});
      },
    });
    settle(await mapper.start());
    writeAddresses();
    const summary = upnp.mappings.map((m) => `${m.protocol} ${m.port} ${m.ok ? 'mapped' : m.error}`).join(', ');
    ctx?.logger.info(`UPnP: ${summary}`, { cgnat: status().cgnat });
  };

  return {
    name: NET_MODULE,
    init(c) {
      ctx = c;
    },
    start(info) {
      port = info.port;
      local = readLocal();
      writeAddresses();
      if (upnpEnabled) work = runUpnp().catch((e: unknown) => {
        upnp.state = 'failed';
        ctx?.logger.warn('UPnP failed', { error: e instanceof Error ? e.message : String(e) });
      });
      timer = setInterval(() => void this.refresh(), opts.refreshMs ?? NET_REFRESH_MS);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.race([work, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())]);
      await mapper?.stop();
    },
    status,
    nodeIp,
    ready: () => work,
    async refresh() {
      if (!stopped && port !== 0) {
        local = readLocal();
        writeAddresses();
      }
      return status();
    },
  };
}

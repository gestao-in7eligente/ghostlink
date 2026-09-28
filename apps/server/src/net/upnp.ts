// A minimal UPnP IGD client (spec §2.2, §8.5): SSDP M-SEARCH, the device-description
// XML and the SOAP actions GetExternalIPAddress / AddPortMapping / DeletePortMapping,
// for IGD v1 and v2 with WANIPConnection or WANPPPConnection. No third-party packages.
//
// Everything a router (or anything on the LAN pretending to be one) sends is bounded
// and validated: SSDP replies ≤ 2 KB, descriptions ≤ 64 KB, SOAP answers ≤ 16 KB,
// no redirects, and every URL must stay on the host that answered the SSDP search.
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { request, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { isCgnatOrPrivate, localIPv4Addresses } from './addresses.js';

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
/** spec §8.5: 2 h leases, renewed. */
export const UPNP_LEASE_SECONDS = 7_200;
export const UPNP_DESCRIPTION = 'GhostLink';

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
/** Best first. */
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const MAX_SSDP_BYTES = 2_048;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const MAX_SOAP_BYTES = 16 * 1024;
const MAX_LOCATIONS = 16;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export type UpnpProtocol = 'TCP' | 'UDP';

export interface WanService {
  serviceType: string;
  controlUrl: string;
}

export interface UpnpGateway {
  location: string;
  /** WAN connection services, best first. */
  services: WanService[];
  /** This machine's IP on the route to the gateway: the NewInternalClient of every mapping. */
  localAddress: string;
}

/** A UPnP error answer (e.g. 718 ConflictInMappingEntry, 725 OnlyPermanentLeasesSupported). */
export class UpnpError extends Error {
  override readonly name = 'UpnpError';
  constructor(
    readonly upnpCode: number,
    description: string,
  ) {
    super(`UPnP error ${upnpCode}: ${description}`);
  }
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** The text of the first <name> element (any namespace prefix), decoded; null when absent. */
function element(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? decodeXml(m[1]!.trim()) : null;
}

/** The LOCATION of an SSDP "200 OK" search answer, or null. */
export function parseSsdpResponse(text: string): string | null {
  if (text.length > MAX_SSDP_BYTES || !/^HTTP\/1\.[01] 200\b/.test(text)) return null;
  const m = /\r\nlocation:[ \t]*([^\r\n]+)/i.exec(text);
  return m ? m[1]!.trim() : null;
}

function sameHost(a: URL, b: URL): boolean {
  return a.hostname === b.hostname;
}

/**
 * The WAN connection services in a device description, best first. Control URLs are
 * resolved against URLBase (or the description URL) and must be http: on the same
 * host as the description: a router description never sends us anywhere else.
 */
export function parseDescription(xml: string, location: string): WanService[] {
  const origin = new URL(location);
  const baseText = element(xml, 'URLBase');
  let base = origin;
  if (baseText) {
    try {
      base = new URL(baseText);
    } catch {
      return [];
    }
    if (base.protocol !== 'http:' || !sameHost(base, origin)) return [];
  }
  const found: WanService[] = [];
  for (const block of xml.match(/<(?:[\w.-]+:)?service(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?service>/g) ?? []) {
    const serviceType = element(block, 'serviceType');
    const control = element(block, 'controlURL');
    if (!serviceType || !control || !WAN_SERVICES.includes(serviceType)) continue;
    let url: URL;
    try {
      url = new URL(control, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' || !sameHost(url, origin)) continue;
    if (!found.some((f) => f.serviceType === serviceType)) found.push({ serviceType, controlUrl: url.href });
  }
  return found.sort((a, b) => WAN_SERVICES.indexOf(a.serviceType) - WAN_SERVICES.indexOf(b.serviceType));
}

interface HttpResult {
  status: number;
  body: string;
  localAddress: string;
}

/** One bounded HTTP exchange: no redirects, no keep-alive, size and time limits. */
function httpExchange(url: URL, opts: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; maxBytes: number; timeoutMs: number }): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let localAddress = '';
    const req = request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: { connection: 'close', ...opts.headers, ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}) },
        agent: false,
        timeout: opts.timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > opts.maxBytes) {
            req.destroy(new Error('UPnP answer too large'));
            return;
          }
          chunks.push(d);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), localAddress }));
        res.on('error', reject);
      },
    );
    req.on('socket', (socket) => socket.once('connect', () => (localAddress = (socket.localAddress ?? '').replace(/^::ffff:/, ''))));
    req.on('timeout', () => req.destroy(new Error('UPnP request timed out')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

export interface DiscoverOptions {
  /** Total time to wait for answers (default 3 s). */
  timeoutMs?: number;
  /** Tests point these at a fake IGD. */
  ssdpAddress?: string;
  ssdpPort?: number;
  /** Local IPv4s to search from (default: the LAN addresses; else the default route). */
  interfaces?: string[];
  httpTimeoutMs?: number;
}

/** A gateway a router sent back through SSDP may only live on a private (or loopback) address. */
function plausibleRouter(address: string): boolean {
  return isIP(address) === 4 && (isCgnatOrPrivate(address) || address.startsWith('127.'));
}

async function describe(location: string, responder: string, httpTimeoutMs: number): Promise<UpnpGateway | null> {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  // The description must be on the host that answered (no SSRF through a spoofed LOCATION).
  if (url.protocol !== 'http:' || url.hostname !== responder) return null;
  try {
    const res = await httpExchange(url, { method: 'GET', maxBytes: MAX_DESCRIPTION_BYTES, timeoutMs: httpTimeoutMs });
    if (res.status !== 200) return null;
    const services = parseDescription(res.body, url.href);
    if (services.length === 0 || !IPV4.test(res.localAddress)) return null;
    return { location: url.href, services, localAddress: res.localAddress };
  } catch {
    return null;
  }
}

/** SSDP search, then the first answering gateway whose description has a WAN connection service. */
export async function discoverGateway(opts: DiscoverOptions = {}): Promise<UpnpGateway | null> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const target = opts.ssdpAddress ?? SSDP_ADDRESS;
  const port = opts.ssdpPort ?? SSDP_PORT;
  const lan = localIPv4Addresses().filter((a) => a.kind === 'lan').map((a) => a.ip);
  const interfaces: Array<string | undefined> = opts.interfaces ?? (lan.length > 0 ? lan : [undefined]);
  const httpTimeoutMs = opts.httpTimeoutMs ?? 3_000;

  return new Promise((resolve) => {
    const sockets: UdpSocket[] = [];
    const seen = new Set<string>();
    let pending = 0;
    let settled = false;
    let timedOut = false;
    const finish = (gw: UpnpGateway | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of sockets) s.close();
      resolve(gw);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pending === 0) finish(null);
    }, timeoutMs);

    for (const iface of interfaces) {
      const socket = createSocket({ type: 'udp4', reuseAddr: false });
      sockets.push(socket);
      socket.on('error', () => {});
      socket.on('message', (msg, rinfo) => {
        if (settled || msg.length > MAX_SSDP_BYTES) return;
        const location = parseSsdpResponse(msg.toString('utf8'));
        if (!location || seen.has(location) || seen.size >= MAX_LOCATIONS || !plausibleRouter(rinfo.address)) return;
        seen.add(location);
        pending++;
        void describe(location, rinfo.address, httpTimeoutMs).then((gw) => {
          pending--;
          if (gw) finish(gw);
          else if (timedOut && pending === 0) finish(null);
        });
      });
      socket.bind({ port: 0, address: iface }, () => {
        if (target === SSDP_ADDRESS) {
          try {
            socket.setMulticastTTL(2);
            if (iface) socket.setMulticastInterface(iface);
          } catch {
            // best effort
          }
        }
        const send = () => {
          if (settled) return;
          for (const st of SEARCH_TARGETS) {
            const msg = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
            socket.send(msg, port, target);
          }
        };
        send();
        setTimeout(send, Math.min(500, timeoutMs / 3)).unref(); // UDP can drop the first burst
      });
    }
  });
}

export interface MappingRequest {
  protocol: UpnpProtocol;
  /** The same port outside and inside. */
  port: number;
  description?: string;
  leaseSeconds?: number;
}

/** SOAP calls to one gateway; the first service that answers is kept. */
export class UpnpClient {
  readonly gateway: UpnpGateway;
  readonly #timeoutMs: number;
  #service: WanService;

  constructor(gateway: UpnpGateway, opts: { timeoutMs?: number } = {}) {
    if (gateway.services.length === 0) throw new Error('the gateway has no WAN connection service');
    this.gateway = gateway;
    this.#service = gateway.services[0]!;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /** The WAN IPv4 the router reports, or null (not connected, or not an IPv4). */
  async externalIp(): Promise<string | null> {
    // Some routers list both WANIPConnection and WANPPPConnection with only one connected.
    for (const service of [this.#service, ...this.gateway.services.filter((s) => s !== this.#service)]) {
      try {
        const body = await this.#call(service, 'GetExternalIPAddress', '');
        const ip = element(body, 'NewExternalIPAddress');
        if (ip && IPV4.test(ip) && ip !== '0.0.0.0') {
          this.#service = service;
          return ip;
        }
      } catch {
        // try the next service
      }
    }
    return null;
  }

  /** Maps protocol/port to this machine. Retries with a permanent lease on error 725. */
  async addPortMapping(m: MappingRequest): Promise<{ leaseSeconds: number }> {
    const lease = m.leaseSeconds ?? UPNP_LEASE_SECONDS;
    try {
      await this.#add(m, lease);
      return { leaseSeconds: lease };
    } catch (e) {
      if (!(e instanceof UpnpError) || e.upnpCode !== 725 || lease === 0) throw e;
      await this.#add(m, 0);
      return { leaseSeconds: 0 };
    }
  }

  async deletePortMapping(m: Pick<MappingRequest, 'protocol' | 'port'>): Promise<void> {
    await this.#call(this.#service, 'DeletePortMapping', `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.port}</NewExternalPort><NewProtocol>${m.protocol}</NewProtocol>`);
  }

  async #add(m: MappingRequest, lease: number): Promise<void> {
    const args =
      `<NewRemoteHost></NewRemoteHost><NewExternalPort>${m.port}</NewExternalPort><NewProtocol>${m.protocol}</NewProtocol>` +
      `<NewInternalPort>${m.port}</NewInternalPort><NewInternalClient>${escapeXml(this.gateway.localAddress)}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled><NewPortMappingDescription>${escapeXml(m.description ?? UPNP_DESCRIPTION)}</NewPortMappingDescription>` +
      `<NewLeaseDuration>${lease}</NewLeaseDuration>`;
    await this.#call(this.#service, 'AddPortMapping', args);
  }

  async #call(service: WanService, action: string, args: string): Promise<string> {
    if (!/^[A-Za-z]+$/.test(action)) throw new Error('invalid UPnP action');
    const body =
      '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${service.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`;
    const res = await httpExchange(new URL(service.controlUrl), {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service.serviceType}#${action}"` },
      body,
      maxBytes: MAX_SOAP_BYTES,
      timeoutMs: this.#timeoutMs,
    });
    if (res.status === 200) return res.body;
    const code = Number(element(res.body, 'errorCode'));
    throw new UpnpError(Number.isInteger(code) && code > 0 ? code : res.status, element(res.body, 'errorDescription') ?? `HTTP ${res.status}`);
  }
}

export type MappingResult =
  | { protocol: UpnpProtocol; port: number; ok: true; leaseSeconds: number }
  | { protocol: UpnpProtocol; port: number; ok: false; error: 'conflict' | 'refused' | 'unreachable' };

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PortMapperOptions {
  client: Pick<UpnpClient, 'addPortMapping' | 'deletePortMapping'>;
  ports: Array<{ protocol: UpnpProtocol; port: number }>;
  leaseSeconds?: number;
  /** Renewal even for permanent leases (routers forget them on reboot). */
  permanentRenewMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (t: TimerHandle) => void;
  onRenew?: (result: MappingResult[]) => void;
}

function failure(e: unknown): 'conflict' | 'refused' | 'unreachable' {
  if (e instanceof UpnpError) return e.upnpCode === 718 ? 'conflict' : 'refused';
  return 'unreachable';
}

/** spec §8.5: maps the public ports with 2 h leases, renews them at half-life, and unmaps them all on stop. */
export class PortMapper {
  readonly #o: PortMapperOptions;
  readonly #mapped = new Set<string>();
  #timer: TimerHandle | null = null;
  #stopped = false;

  constructor(opts: PortMapperOptions) {
    this.#o = opts;
  }

  async start(): Promise<MappingResult[]> {
    const result = await this.#mapAll();
    this.#schedule(result);
    return result;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) (this.#o.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = null;
    await Promise.all(
      this.#o.ports
        .filter((p) => this.#mapped.has(`${p.protocol}:${p.port}`))
        .map((p) => this.#o.client.deletePortMapping(p).catch(() => {})),
    );
    this.#mapped.clear();
  }

  async #mapAll(): Promise<MappingResult[]> {
    const out: MappingResult[] = [];
    for (const p of this.#o.ports) {
      if (this.#stopped) break;
      try {
        const { leaseSeconds } = await this.#o.client.addPortMapping({ ...p, leaseSeconds: this.#o.leaseSeconds ?? UPNP_LEASE_SECONDS });
        if (this.#stopped) {
          // stop() ran while this mapping was on its way: undo it now, not in 2 h.
          await this.#o.client.deletePortMapping(p).catch(() => {});
          break;
        }
        this.#mapped.add(`${p.protocol}:${p.port}`);
        out.push({ ...p, ok: true, leaseSeconds });
      } catch (e) {
        out.push({ ...p, ok: false, error: failure(e) });
      }
    }
    return out;
  }

  #schedule(result: MappingResult[]): void {
    if (this.#stopped) return;
    const leases = result.flatMap((r) => (r.ok && r.leaseSeconds > 0 ? [r.leaseSeconds] : []));
    const ms = leases.length > 0 ? (Math.min(...leases) * 1_000) / 2 : (this.#o.permanentRenewMs ?? 3_600_000);
    const timer = (this.#o.setTimer ?? setTimeout)(() => {
      void this.#mapAll().then((again) => {
        this.#o.onRenew?.(again);
        this.#schedule(again);
      });
    }, ms);
    timer.unref?.();
    this.#timer = timer;
  }
}

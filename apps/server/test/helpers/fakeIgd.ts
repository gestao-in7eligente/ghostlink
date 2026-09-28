// A fake UPnP Internet Gateway Device for tests: an SSDP responder (unicast, on
// 127.0.0.1) and an HTTP server with the device description and the SOAP control URL.
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeService = 'WANIPConnection:1' | 'WANIPConnection:2' | 'WANPPPConnection:1';

export interface FakeIgdOptions {
  /** Services listed in the description, in order (default: WANIPConnection:1). */
  services?: FakeService[];
  /** The WAN IP GetExternalIPAddress returns (default 203.0.113.7). */
  externalIp?: string;
  /** Like many routers: refuse non-zero leases with error 725. */
  onlyPermanentLeases?: boolean;
  /** "protocol:port" entries already mapped to another host (error 718). */
  conflicts?: string[];
  /** Overrides the LOCATION header (e.g. another host, to test that it is ignored). */
  location?: (httpBase: string) => string;
  /** Overrides the controlURL in the description. */
  controlUrl?: (httpBase: string) => string;
  /** Pads the description to this many bytes. */
  descriptionPadding?: number;
  /** Use a URLBase element and a relative controlURL. */
  urlBase?: boolean;
  /** Do not answer SSDP at all. */
  silent?: boolean;
}

export interface FakeMapping {
  protocol: string;
  externalPort: number;
  internalPort: number;
  internalClient: string;
  description: string;
  lease: number;
}

export interface FakeIgd {
  ssdpPort: number;
  httpPort: number;
  /** Current mappings by "protocol:externalPort". */
  mappings: Map<string, FakeMapping>;
  /** Every SOAP action received, in order ("AddPortMapping", …). */
  actions: string[];
  /** Every M-SEARCH ST received. */
  searches: string[];
  close(): Promise<void>;
}

const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';

function tag(body: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`).exec(body);
  return m ? m[1]! : null;
}

function soapOk(service: string, action: string, inner = ''): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="${SOAP_ENV}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

function soapFault(code: number, description: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="${SOAP_ENV}"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => resolve(body));
  });
}

export async function startFakeIgd(opts: FakeIgdOptions = {}): Promise<FakeIgd> {
  const services = opts.services ?? ['WANIPConnection:1'];
  const mappings = new Map<string, FakeMapping>();
  const actions: string[] = [];
  const searches: string[] = [];

  const http: Server = createServer((req, res) => {
    void (async () => {
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      if (req.method === 'GET' && req.url === '/desc.xml') {
        const control = opts.controlUrl?.(base) ?? (opts.urlBase ? '/ctl/IPConn' : `${base}/ctl/IPConn`);
        const serviceXml = services
          .map((s) => `<service><serviceType>urn:schemas-upnp-org:service:${s}</serviceType><serviceId>urn:upnp-org:serviceId:${s.split(':')[0]}</serviceId><controlURL>${control}</controlURL><eventSubURL>/evt</eventSubURL><SCPDURL>/scpd.xml</SCPDURL></service>`)
          .join('');
        const xml = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>${opts.urlBase ? `<URLBase>${base}/</URLBase>` : ''}<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>Fake &amp; Router</friendlyName><deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList><device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType><serviceList>${serviceXml}</serviceList></device></deviceList></device></deviceList></device></root>`;
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(xml + ' '.repeat(opts.descriptionPadding ?? 0));
        return;
      }
      if (req.method === 'POST' && req.url === '/ctl/IPConn') {
        const soapAction = String(req.headers.soapaction ?? '').replace(/"/g, '');
        const [serviceUrn, action] = soapAction.split('#');
        const service = serviceUrn?.replace('urn:schemas-upnp-org:service:', '') ?? '';
        const body = await readBody(req);
        actions.push(action ?? '');
        const fault = (code: number, d: string) => {
          res.writeHead(500, { 'content-type': 'text/xml' });
          res.end(soapFault(code, d));
        };
        if (!services.includes(service as FakeService) || !body.includes(`<u:${action} `)) return fault(401, 'Invalid Action');
        const ok = (inner = '') => {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(soapOk(service, action!, inner));
        };
        if (action === 'GetExternalIPAddress') return ok(`<NewExternalIPAddress>${opts.externalIp ?? '203.0.113.7'}</NewExternalIPAddress>`);
        const protocol = tag(body, 'NewProtocol') ?? '';
        const externalPort = Number(tag(body, 'NewExternalPort'));
        const key = `${protocol}:${externalPort}`;
        if (action === 'AddPortMapping') {
          const lease = Number(tag(body, 'NewLeaseDuration'));
          if (opts.onlyPermanentLeases && lease !== 0) return fault(725, 'OnlyPermanentLeasesSupported');
          if (opts.conflicts?.includes(key)) return fault(718, 'ConflictInMappingEntry');
          mappings.set(key, {
            protocol,
            externalPort,
            internalPort: Number(tag(body, 'NewInternalPort')),
            internalClient: tag(body, 'NewInternalClient') ?? '',
            description: tag(body, 'NewPortMappingDescription') ?? '',
            lease,
          });
          return ok();
        }
        if (action === 'DeletePortMapping') {
          if (!mappings.delete(key)) return fault(714, 'NoSuchEntryInArray');
          return ok();
        }
        return fault(401, 'Invalid Action');
      }
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const httpPort = (http.address() as AddressInfo).port;
  const httpBase = `http://127.0.0.1:${httpPort}`;

  const ssdp: UdpSocket = createSocket('udp4');
  ssdp.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (!text.startsWith('M-SEARCH * HTTP/1.1') || !/\r\nMAN: "ssdp:discover"\r\n/i.test(text)) return;
    const st = /\r\nST: *([^\r\n]+)/i.exec(text)?.[1] ?? '';
    searches.push(st);
    if (opts.silent) return;
    const location = opts.location?.(httpBase) ?? `${httpBase}/desc.xml`;
    const reply = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: ${st}\r\nUSN: uuid:fake::${st}\r\nEXT:\r\nSERVER: Fake/1.0 UPnP/1.1\r\nLOCATION: ${location}\r\n\r\n`;
    ssdp.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', () => r()));

  return {
    ssdpPort: ssdp.address().port,
    httpPort,
    mappings,
    actions,
    searches,
    close: async () => {
      await new Promise<void>((r) => ssdp.close(() => r()));
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections();
      });
    },
  };
}

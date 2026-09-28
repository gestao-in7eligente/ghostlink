import { z } from 'zod';
import { CRYPTO_LABELS, DEFAULT_PORT, LIMITS } from './constants.js';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';
import { sanitizeLabel } from './text.js';

export interface InvitePayload {
  addresses: string[]; // "host:port", 1..8
  serverKeyId: string;
  inviteCode?: string;
  name?: string;
}

export type ParsedJoinInput =
  | { kind: 'invite'; invite: InvitePayload }
  | { kind: 'address'; address: string }; // bare host[:port] → TOFU flow

const INVITE_NAME_MAX_GRAPHEMES = 64;
const MAX_ADDRESS_LENGTH = 262; // "[" + 45-char IPv6 + "]:" + port, or a 253-char hostname + ":65535"
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`);
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const PORT = /^[0-9]{1,5}$/;
const SERVER_KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const INVITE_CODE = /^[A-Z2-7]{10}$/;

function bad(message: string): ProtocolError {
  return new ProtocolError('BAD_REQUEST', message);
}

function normalizeIPv6(host: string): string {
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(host)) throw bad('invalid IPv6 address');
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    throw bad('invalid IPv6 address');
  }
}

/**
 * Parses "host", "host:port", "[v6]" or "[v6]:port". Hostnames are lowercased;
 * IPv6 is returned without brackets in canonical form. Default port: DEFAULT_PORT.
 */
export function parseHostPort(s: string): { host: string; port: number } {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_ADDRESS_LENGTH) throw bad('invalid address');
  let host: string;
  let portText: string | undefined;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) throw bad('invalid address');
    host = normalizeIPv6(s.slice(1, end));
    const rest = s.slice(end + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
    else if (rest !== '') throw bad('invalid address');
  } else {
    const parts = s.split(':');
    if (parts.length > 2) throw bad('IPv6 addresses must be written in brackets');
    host = parts[0]!.toLowerCase();
    portText = parts[1];
    const numeric = /^[0-9.]+$/.test(host);
    if (numeric ? !IPV4.test(host) : !HOSTNAME.test(host)) throw bad('invalid host');
  }
  let port = DEFAULT_PORT;
  if (portText !== undefined) {
    if (!PORT.test(portText)) throw bad('invalid port');
    port = Number(portText);
    if (port < 1 || port > 65535) throw bad('invalid port');
  }
  return { host, port };
}

/** Inverse of parseHostPort: brackets IPv6 literals. */
export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Uppercases and validates an invite code (10 base32 characters); null when malformed. */
export function normalizeInviteCode(code: string): string | null {
  if (typeof code !== 'string') return null;
  const upper = code.trim().toUpperCase();
  return INVITE_CODE.test(upper) ? upper : null;
}

function normalizePayload(p: InvitePayload): InvitePayload {
  if (!Array.isArray(p.addresses) || p.addresses.length < 1 || p.addresses.length > LIMITS.inviteMaxAddresses) {
    throw bad(`an invite needs 1 to ${LIMITS.inviteMaxAddresses} addresses`);
  }
  const addresses: string[] = [];
  for (const a of p.addresses) {
    const { host, port } = parseHostPort(a);
    const canonical = formatHostPort(host, port);
    if (!addresses.includes(canonical)) addresses.push(canonical);
  }
  if (typeof p.serverKeyId !== 'string' || !SERVER_KEY_ID.test(p.serverKeyId) || fromBase64Url(p.serverKeyId).length !== 32) {
    throw bad('invalid serverKeyId');
  }
  const out: InvitePayload = { addresses, serverKeyId: p.serverKeyId };
  if (p.inviteCode !== undefined) {
    const code = normalizeInviteCode(p.inviteCode);
    if (code === null) throw bad('invalid invite code');
    out.inviteCode = code;
  }
  if (p.name !== undefined) {
    const name = sanitizeLabel(p.name, INVITE_NAME_MAX_GRAPHEMES);
    if (name !== '') out.name = name;
  }
  return out;
}

function checkLength(s: string): string {
  if (s.length > LIMITS.inviteMaxLength) throw bad('invite too long');
  return s;
}

/** ghostlink://join?h=a,b&k=<serverKeyId>&i=<code>&n=<name> */
export function formatInviteLink(p: InvitePayload): string {
  const v = normalizePayload(p);
  const q = new URLSearchParams();
  q.set('h', v.addresses.join(','));
  q.set('k', v.serverKeyId);
  if (v.inviteCode !== undefined) q.set('i', v.inviteCode);
  if (v.name !== undefined) q.set('n', v.name);
  return checkLength(`${CRYPTO_LABELS.scheme}://join?${q.toString()}`);
}

/** "GL1-" + base64url(UTF-8(JSON {h, k, i, n})) */
export function formatPasteCode(p: InvitePayload): string {
  const v = normalizePayload(p);
  const json = JSON.stringify({ h: v.addresses, k: v.serverKeyId, i: v.inviteCode, n: v.name });
  return checkLength(CRYPTO_LABELS.pastePrefix + toBase64Url(utf8(json)));
}

/** `${siteBase}/j/#GL1-…` — the fragment never reaches any web server. */
export function formatWebLink(p: InvitePayload, siteBase: string): string {
  return checkLength(`${siteBase.replace(/\/+$/, '')}/j/#${formatPasteCode(p)}`);
}

const pasteJsonSchema = z.object({
  h: z.array(z.string().max(MAX_ADDRESS_LENGTH)).min(1).max(LIMITS.inviteMaxAddresses),
  k: z.string().max(64),
  i: z.string().max(64).optional(),
  n: z.string().max(1024).optional(),
});

function parseInviteLink(s: string): InvitePayload {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad('invalid invite link');
  }
  if (url.protocol !== `${CRYPTO_LABELS.scheme}:` || url.hostname !== 'join' || url.port !== ''
    || url.username !== '' || url.password !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw bad('invalid invite link');
  }
  const params = url.searchParams;
  for (const key of ['h', 'k', 'i', 'n']) {
    if (params.getAll(key).length > 1) throw bad(`duplicate "${key}" parameter`);
  }
  const h = params.get('h');
  const k = params.get('k');
  if (h === null || k === null) throw bad('invite link needs h and k');
  const payload: InvitePayload = { addresses: h.split(','), serverKeyId: k };
  const i = params.get('i');
  const n = params.get('n');
  if (i !== null) payload.inviteCode = i;
  if (n !== null) payload.name = n;
  return normalizePayload(payload);
}

function parsePasteCode(s: string): InvitePayload {
  const body = s.slice(CRYPTO_LABELS.pastePrefix.length);
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(fromBase64Url(body)));
  } catch {
    throw bad('invalid invite code');
  }
  const parsed = pasteJsonSchema.safeParse(json);
  if (!parsed.success) throw bad('invalid invite code');
  const payload: InvitePayload = { addresses: parsed.data.h, serverKeyId: parsed.data.k };
  if (parsed.data.i !== undefined) payload.inviteCode = parsed.data.i;
  if (parsed.data.n !== undefined) payload.name = parsed.data.n;
  return normalizePayload(payload);
}

function parseWebLink(s: string): InvitePayload {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad('invalid invite link');
  }
  const marker = `#${CRYPTO_LABELS.pastePrefix}`;
  if (!url.hash.startsWith(marker)) throw bad('link does not contain a GhostLink invite');
  return parsePasteCode(url.hash.slice(1));
}

/**
 * Accepts everything a person may paste into "Join": a ghostlink:// link,
 * a GL1- paste code, a web link with a #GL1- fragment, or a bare host[:port]
 * (TOFU flow). Throws ProtocolError('BAD_REQUEST') on anything else.
 */
export function parseJoinInput(input: string): ParsedJoinInput {
  if (typeof input !== 'string') throw bad('invalid input');
  const s = input.trim();
  if (s.length === 0 || s.length > LIMITS.inviteMaxLength) throw bad('invalid input');
  const lower = s.toLowerCase();
  if (lower.startsWith(`${CRYPTO_LABELS.scheme}:`)) return { kind: 'invite', invite: parseInviteLink(s) };
  if (s.startsWith(CRYPTO_LABELS.pastePrefix)) return { kind: 'invite', invite: parsePasteCode(s) };
  if (lower.startsWith('https://') || lower.startsWith('http://')) return { kind: 'invite', invite: parseWebLink(s) };
  const { host, port } = parseHostPort(s);
  return { kind: 'address', address: formatHostPort(host, port) };
}

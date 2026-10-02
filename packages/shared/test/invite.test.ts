import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  LIMITS,
  ProtocolError,
  formatHostPort,
  formatInviteLink,
  formatPasteCode,
  formatWebLink,
  normalizeInviteCode,
  parseHostPort,
  parseJoinInput,
  toBase64Url,
  utf8,
  type InvitePayload,
} from '../src/index.js';

const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i * 7));
const SITE = 'https://gestao-in7eligente.github.io/ghostlink'; // the real WEB_SITE_BASE: an origin plus a path

function expectBadRequest(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('parseHostPort', () => {
  it.each([
    ['example.com', 'example.com', DEFAULT_PORT],
    ['Example.COM:7701', 'example.com', 7701],
    ['192.168.0.10', '192.168.0.10', DEFAULT_PORT],
    ['26.1.2.3:1', '26.1.2.3', 1],
    ['localhost:65535', 'localhost', 65535],
    ['[::1]', '::1', DEFAULT_PORT],
    ['[::1]:7700', '::1', 7700],
    ['[2001:DB8:0:0:0:0:0:1]:9000', '2001:db8::1', 9000],
    ['my-host.tail1234.ts.net:7700', 'my-host.tail1234.ts.net', 7700],
  ])('parses %j', (input, host, port) => {
    expect(parseHostPort(input)).toEqual({ host, port });
  });

  it.each([
    '', ':7700', 'host:', 'host:0', 'host:65536', 'host:+80', 'host:80x', 'host:0x50', 'host:007700',
    '::1', '2001:db8::1', // bare IPv6 is ambiguous with a port
    '[::1', '[::1]x', '[not-ip]:1', '[fe80::1%eth0]:1',
    '256.1.1.1', '1.2.3', '01.2.3.4', 'user@host', 'host/path', 'host name', '-host', 'host-', 'a..b', 'host.',
    'ho_st', 'hóst', `${'a'.repeat(64)}.com`, `${'a.'.repeat(126)}com`,
  ])('rejects %j', (input) => {
    expectBadRequest(() => parseHostPort(input));
  });

  it('formatHostPort brackets IPv6 and round-trips', () => {
    for (const s of ['example.com:7700', '10.0.0.1:1', '[::1]:7700', '[2001:db8::1]:9000']) {
      const { host, port } = parseHostPort(s);
      expect(formatHostPort(host, port)).toBe(s);
    }
  });
});

describe('normalizeInviteCode', () => {
  it('uppercases valid codes', () => {
    expect(normalizeInviteCode('abcdefgh23')).toBe('ABCDEFGH23');
    expect(normalizeInviteCode(' ABCDEFGH23 ')).toBe('ABCDEFGH23');
  });

  it.each(['', 'ABCDEFGH2', 'ABCDEFGH234', 'ABCDEFGH01', 'ABCDEFGH-2', 'ÁBCDEFGH23'])('rejects %j', (c) => {
    expect(normalizeInviteCode(c)).toBeNull();
  });
});

describe('invite formats', () => {
  const payload: InvitePayload = {
    addresses: ['203.0.113.5:7700', 'Casa.Example.com:7710', '[2001:db8::5]:7700'],
    serverKeyId: KEY_ID,
    inviteCode: 'ABCDEFGH23',
    name: 'Servidor do Zé',
  };
  const normalized: InvitePayload = { ...payload, addresses: ['203.0.113.5:7700', 'casa.example.com:7710', '[2001:db8::5]:7700'] };

  it('link round-trips through parseJoinInput', () => {
    const link = formatInviteLink(payload);
    expect(link.startsWith('ghostlink://join?')).toBe(true);
    expect(parseJoinInput(link)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('paste code round-trips and has the frozen prefix', () => {
    const code = formatPasteCode(payload);
    expect(code).toMatch(/^GL1-[A-Za-z0-9_-]+$/);
    expect(parseJoinInput(code)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('web link carries the paste code only in the fragment', () => {
    const web = formatWebLink(payload, `${SITE}/`);
    const url = new URL(web);
    expect(url.origin + url.pathname).toBe(`${SITE}/j/`);
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#${formatPasteCode(payload)}`);
    expect(parseJoinInput(web)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('omits optional fields and still round-trips', () => {
    const minimal: InvitePayload = { addresses: ['10.0.0.1:7700'], serverKeyId: KEY_ID };
    expect(parseJoinInput(formatInviteLink(minimal))).toEqual({ kind: 'invite', invite: minimal });
    expect(parseJoinInput(formatPasteCode(minimal))).toEqual({ kind: 'invite', invite: minimal });
  });

  it('carries the channel of "Convite para o canal" through every format, and drops a malformed one (v0.5.0)', () => {
    const CHANNEL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const withChannel: InvitePayload = { ...payload, channelId: CHANNEL };
    for (const text of [formatInviteLink(withChannel), formatPasteCode(withChannel), formatWebLink(withChannel, SITE)]) {
      expect(parseJoinInput(text)).toEqual({ kind: 'invite', invite: { ...normalized, channelId: CHANNEL } });
    }
    expect(formatInviteLink(withChannel)).toContain(`&c=${CHANNEL}`);
    // Only a hint: a bad or repeated channel leaves a valid invite without it.
    expect(parseJoinInput(`${formatInviteLink(payload)}&c=nope`)).toEqual({ kind: 'invite', invite: normalized });
    expect(parseJoinInput(`${formatInviteLink(withChannel)}&c=${CHANNEL}`)).toEqual({ kind: 'invite', invite: normalized });
    const paste = (obj: unknown) => `GL1-${toBase64Url(utf8(JSON.stringify(obj)))}`;
    expect(parseJoinInput(paste({ h: payload.addresses, k: KEY_ID, c: 42 }))).toEqual({ kind: 'invite', invite: { addresses: normalized.addresses, serverKeyId: KEY_ID } });
  });

  it('accepts a trailing slash after the link host (Windows shells add it)', () => {
    const link = formatInviteLink(payload).replace('ghostlink://join?', 'ghostlink://join/?');
    expect(parseJoinInput(link)).toEqual({ kind: 'invite', invite: normalized });
  });

  it('deduplicates addresses and fills the default port', () => {
    const p: InvitePayload = { addresses: ['a.example', 'a.example:7700', 'A.EXAMPLE'], serverKeyId: KEY_ID };
    expect(parseJoinInput(formatPasteCode(p))).toEqual({
      kind: 'invite',
      invite: { addresses: ['a.example:7700'], serverKeyId: KEY_ID },
    });
  });

  it('sanitizes the name hint (bidi spoofing) and drops an invisible one', () => {
    const spoof = parseJoinInput(formatPasteCode({ ...payload, name: 'Banco‮ oficial' }));
    expect(spoof.kind === 'invite' && spoof.invite.name).toBe('Banco oficial');
    const invisible = parseJoinInput(formatPasteCode({ ...payload, name: '​ㅤ' }));
    expect(invisible.kind === 'invite' && 'name' in invisible.invite).toBe(false);
  });
});

describe('parseJoinInput limits and malicious input', () => {
  const base: InvitePayload = { addresses: ['10.0.0.1:7700'], serverKeyId: KEY_ID };
  const paste = (obj: unknown) => `GL1-${toBase64Url(utf8(JSON.stringify(obj)))}`;

  it('treats a bare host[:port] as a TOFU address', () => {
    expect(parseJoinInput('  192.168.0.2 ')).toEqual({ kind: 'address', address: '192.168.0.2:7700' });
    expect(parseJoinInput('[::1]:7701')).toEqual({ kind: 'address', address: '[::1]:7701' });
    expect(parseJoinInput('Meu-PC.local:7700')).toEqual({ kind: 'address', address: 'meu-pc.local:7700' });
  });

  it(`accepts ${LIMITS.inviteMaxAddresses} addresses and rejects ${LIMITS.inviteMaxAddresses + 1}`, () => {
    const addrs = (n: number) => Array.from({ length: n }, (_, i) => `10.0.0.${i + 1}:7700`);
    expect(parseJoinInput(formatPasteCode({ ...base, addresses: addrs(8) })).kind).toBe('invite');
    expectBadRequest(() => formatPasteCode({ ...base, addresses: addrs(9) }));
    expectBadRequest(() => parseJoinInput(paste({ h: addrs(9), k: KEY_ID })));
    expectBadRequest(() => parseJoinInput(`ghostlink://join?h=${addrs(9).join(',')}&k=${KEY_ID}`));
  });

  it(`rejects input longer than ${LIMITS.inviteMaxLength} characters before parsing`, () => {
    expectBadRequest(() => parseJoinInput(`ghostlink://join?h=a:1&k=${KEY_ID}&n=${'x'.repeat(2100)}`));
    expectBadRequest(() => parseJoinInput(`GL1-${'A'.repeat(2100)}`));
  });

  it('refuses to format an invite that would exceed the limit', () => {
    // 8 distinct, individually valid 251-char hostnames.
    const long = Array.from({ length: 8 }, (_, i) =>
      `${String.fromCharCode(97 + i)}${'x'.repeat(59)}.${'y'.repeat(60)}.${'z'.repeat(60)}.${'w'.repeat(60)}.example:7700`);
    expect(() => parseHostPort(long[0]!)).not.toThrow();
    expectBadRequest(() => formatInviteLink({ ...base, addresses: long }));
    expectBadRequest(() => formatPasteCode({ ...base, addresses: long }));
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['wrong scheme host', `ghostlink://evil?h=10.0.0.1:1&k=${KEY_ID}`],
    ['credentials in link', `ghostlink://user@join?h=10.0.0.1:1&k=${KEY_ID}`],
    ['link without k', 'ghostlink://join?h=10.0.0.1:1'],
    ['link without h', `ghostlink://join?k=${KEY_ID}`],
    ['duplicate h', `ghostlink://join?h=10.0.0.1:1&h=10.0.0.2:1&k=${KEY_ID}`],
    ['empty address in list', `ghostlink://join?h=10.0.0.1:1,,10.0.0.2:1&k=${KEY_ID}`],
    ['port out of range', `ghostlink://join?h=10.0.0.1:70000&k=${KEY_ID}`],
    ['short serverKeyId', `ghostlink://join?h=10.0.0.1:1&k=${KEY_ID.slice(1)}`],
    ['malformed invite code', `ghostlink://join?h=10.0.0.1:1&k=${KEY_ID}&i=abc`],
    ['paste code with bad base64', 'GL1-%%%'],
    ['paste code with invalid UTF-8', `GL1-${toBase64Url(new Uint8Array([0x7b, 0xff, 0x7d]))}`],
    ['paste code that is not JSON', `GL1-${toBase64Url(utf8('not json'))}`],
    ['paste code with JSON array', paste([1, 2])],
    ['paste code with h as string', paste({ h: '10.0.0.1:1', k: KEY_ID })],
    ['paste code with javascript: address', paste({ h: ['javascript:alert(1)'], k: KEY_ID })],
    ['paste code with __proto__ pollution attempt', `GL1-${toBase64Url(utf8(`{"__proto__":{"x":1},"h":["a:1"],"k":"${KEY_ID}","i":1}`))}`],
    ['web link without fragment', `${SITE}/j/`],
    ['web link with foreign fragment', `${SITE}/j/#hello`],
    ['javascript URL', 'javascript:alert(1)'],
    ['file URL', 'file:///etc/passwd'],
  ])('rejects %s', (_label, input) => {
    expectBadRequest(() => parseJoinInput(input));
  });

  it('rejects non-string input', () => {
    expectBadRequest(() => parseJoinInput(undefined as unknown as string));
  });

  it('does not pollute Object.prototype', () => {
    try {
      parseJoinInput(`GL1-${toBase64Url(utf8(`{"__proto__":{"polluted":1},"h":["a:1"],"k":"${KEY_ID}"}`))}`);
    } catch {
      // either outcome is fine; pollution is not
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

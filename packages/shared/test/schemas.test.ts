import { describe, expect, it } from 'vitest';
import {
  authProofSchema,
  challengeSchemaClient,
  envelopeSchema,
  errorEventSchemaClient,
  helloSchema,
  resSchemaClient,
  toBase64Url,
  welcomeSchemaClient,
} from '../src/index.js';

const B32 = toBase64Url(new Uint8Array(32).fill(1));
const B64 = toBase64Url(new Uint8Array(64).fill(2));
const validHello = {
  protocol: 1,
  publicKey: B32,
  nickname: 'Ana',
  locale: 'pt-BR',
  client: 'ghostlink/0.1.0 (win32)',
};

describe('helloSchema (server side, strict)', () => {
  it('accepts a minimal hello and every optional credential', () => {
    expect(helloSchema.safeParse(validHello).success).toBe(true);
    expect(helloSchema.safeParse({ ...validHello, password: 'x', inviteCode: 'ABCDEFGH23', setupCode: 'a-b' }).success).toBe(true);
  });

  it('accepts any integer protocol so the server can answer PROTOCOL_UNSUPPORTED', () => {
    expect(helloSchema.safeParse({ ...validHello, protocol: 99 }).success).toBe(true);
  });

  it.each([
    ['unknown key', { ...validHello, admin: true }],
    ['__proto__ key', JSON.parse(`{"protocol":1,"publicKey":"${B32}","nickname":"a","locale":"en","client":"c","__proto__":{"x":1}}`)],
    ['missing client', { ...validHello, client: undefined }],
    ['fractional protocol', { ...validHello, protocol: 1.5 }],
    ['protocol as string', { ...validHello, protocol: '1' }],
    ['public key of 31 bytes', { ...validHello, publicKey: toBase64Url(new Uint8Array(31)) }],
    ['public key with padding', { ...validHello, publicKey: `${B32.slice(0, 42)}=` }],
    ['empty nickname', { ...validHello, nickname: '' }],
    ['nickname over 64 raw chars', { ...validHello, nickname: 'a'.repeat(65) }],
    ['locale over 16 chars', { ...validHello, locale: 'pt-BR-xxxxxxxxxxx' }],
    ['locale with injection', { ...validHello, locale: 'en"><script>' }],
    ['empty password', { ...validHello, password: '' }],
    ['password over 256 chars', { ...validHello, password: 'p'.repeat(257) }],
    ['client over 128 chars', { ...validHello, client: 'c'.repeat(129) }],
    ['array payload', [validHello]],
    ['null payload', null],
  ])('rejects %s', (_label, value) => {
    expect(helloSchema.safeParse(value).success).toBe(false);
  });
});

describe('authProofSchema', () => {
  it('accepts a 64-byte signature only', () => {
    expect(authProofSchema.safeParse({ signature: B64 }).success).toBe(true);
    expect(authProofSchema.safeParse({ signature: B32 }).success).toBe(false);
    expect(authProofSchema.safeParse({ signature: B64, extra: 1 }).success).toBe(false);
  });
});

describe('envelopeSchema', () => {
  it('accepts requests and events', () => {
    expect(envelopeSchema.parse({ t: 'ping', id: 1, d: {} })).toEqual({ t: 'ping', id: 1, d: {} });
    expect(envelopeSchema.parse({ t: 'hello', d: { a: 1 } })).toEqual({ t: 'hello', d: { a: 1 } });
  });

  it.each([
    ['negative id', { t: 'x', id: -1 }],
    ['fractional id', { t: 'x', id: 1.5 }],
    ['unsafe integer id', { t: 'x', id: 2 ** 53 }],
    ['long type', { t: 'x'.repeat(65) }],
    ['missing type', { id: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(envelopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('client-side schemas (strip unknown keys, tolerate new error codes)', () => {
  const welcome = {
    self: { userId: 'a'.repeat(32), nickname: 'Ana', isOwner: true },
    sessionId: 's1',
    serverTime: 1,
    server: { name: 'S', version: '0.1.0', joinMode: 'invite', serverKeyId: B32 },
    features: [],
    fileToken: 'tok',
    protocol: { min: 1, max: 1 },
  };

  it('welcome strips unknown fields added by newer servers', () => {
    const parsed = welcomeSchemaClient.parse({ ...welcome, channels: [], extra: 1 });
    expect(parsed).toEqual(welcome);
  });

  it('welcome rejects a malformed userId or join mode', () => {
    expect(welcomeSchemaClient.safeParse({ ...welcome, self: { ...welcome.self, userId: 'x' } }).success).toBe(false);
    expect(welcomeSchemaClient.safeParse({ ...welcome, server: { ...welcome.server, joinMode: 'closed' } }).success).toBe(false);
  });

  it('challenge requires 32-byte nonce and key id', () => {
    expect(challengeSchemaClient.safeParse({ nonce: B32, serverKeyId: B32, x: 1 }).success).toBe(true);
    expect(challengeSchemaClient.safeParse({ nonce: 'short', serverKeyId: B32 }).success).toBe(false);
  });

  it('res distinguishes ok and error, mapping unknown codes to INTERNAL', () => {
    expect(resSchemaClient.parse({ t: 'res', id: 3, ok: true, d: { t: 5 } })).toEqual({ t: 'res', id: 3, ok: true, d: { t: 5 } });
    const err = resSchemaClient.parse({ t: 'res', id: 3, ok: false, error: { code: 'FROM_THE_FUTURE', message: 'm' } });
    expect(err).toEqual({ t: 'res', id: 3, ok: false, error: { code: 'INTERNAL', message: 'm' } });
    expect(resSchemaClient.safeParse({ t: 'res', id: 3, ok: 'yes' }).success).toBe(false);
  });

  it('error event keeps min/max for PROTOCOL_UNSUPPORTED', () => {
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } }))
      .toEqual({ t: 'error', d: { code: 'PROTOCOL_UNSUPPORTED', min: 1, max: 1 } });
    expect(errorEventSchemaClient.parse({ t: 'error', d: { code: 'NEW_CODE' } }).d.code).toBe('INTERNAL');
  });
});

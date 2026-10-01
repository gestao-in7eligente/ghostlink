import { X509Certificate } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCertificate, serverKeyIdFromDer } from '../../../server/src/tls/certificate.js';
import {
  installRendererPinning,
  normalizePins,
  pinsWithdrawn,
  serverKeyIdFromCertificate,
  setRendererPins,
  verifyWithPin,
  verifyWithPins,
  type PinSession,
} from '../../src/main/pinning.js';

let certA: string;
let certB: string;
let certC: string;
let keyA: string;
let keyB: string;
let keyC: string;
beforeAll(async () => {
  certA = (await generateCertificate()).certPem;
  certB = (await generateCertificate()).certPem;
  certC = (await generateCertificate()).certPem;
  keyA = serverKeyIdFromDer(new X509Certificate(certA).raw);
  keyB = serverKeyIdFromDer(new X509Certificate(certB).raw);
  keyC = serverKeyIdFromDer(new X509Certificate(certC).raw);
});

describe('serverKeyIdFromCertificate', () => {
  it('computes the same serverKeyId as the server, from PEM or DER', () => {
    expect(serverKeyIdFromCertificate(certA)).toBe(keyA);
    expect(serverKeyIdFromCertificate(new X509Certificate(certA).raw)).toBe(keyA);
    expect(serverKeyIdFromCertificate(certB)).not.toBe(keyA);
  });
});

describe('verifyWithPin (spec §4)', () => {
  const pin = () => ({ hostname: '203.0.113.5', serverKeyId: keyA });

  it('trusts the pinned host only with the pinned key', () => {
    expect(verifyWithPin(pin(), '203.0.113.5', certA)).toBe(0);
    expect(verifyWithPin(pin(), '203.0.113.5', certB)).toBe(-2);
  });

  it('never falls back to CA validation for the pinned host: garbage is rejected', () => {
    expect(verifyWithPin(pin(), '203.0.113.5', 'not a certificate')).toBe(-2);
  });

  it('leaves other hosts to Chromium, and everything when nothing is pinned', () => {
    expect(verifyWithPin(pin(), '203.0.113.6', certA)).toBe(-3);
    expect(verifyWithPin(pin(), 'example.com', certB)).toBe(-3);
    expect(verifyWithPin(null, '203.0.113.5', certA)).toBe(-3);
  });

  it('compares hostnames case-insensitively and with or without IPv6 brackets', () => {
    expect(verifyWithPin({ hostname: 'Casa.Example', serverKeyId: keyA }, 'casa.example', certA)).toBe(0);
    expect(verifyWithPin({ hostname: '2001:db8::1', serverKeyId: keyA }, '[2001:db8::1]', certA)).toBe(0);
    expect(verifyWithPin({ hostname: '[2001:db8::1]', serverKeyId: keyA }, '2001:db8::1', certB)).toBe(-2);
  });
});

describe("two pins: the server on screen and the call's (chamada-continua §2)", () => {
  it('trusts each pinned host with its own key, and leaves every other host to Chromium', () => {
    const pins = [
      { hostname: '203.0.113.5', serverKeyId: keyA },
      { hostname: 'b.example', serverKeyId: keyB },
    ];
    expect(verifyWithPins(pins, '203.0.113.5', certA)).toBe(0);
    expect(verifyWithPins(pins, 'b.example', certB)).toBe(0);
    expect(verifyWithPins(pins, '203.0.113.5', certB)).toBe(-2);
    expect(verifyWithPins(pins, 'b.example', certA)).toBe(-2);
    expect(verifyWithPins(pins, 'b.example', certC)).toBe(-2);
    expect(verifyWithPins(pins, 'c.example', certC)).toBe(-3);
  });

  it('two servers on one host (the API has no port): either pinned key, and nothing else', () => {
    const pins = [
      { hostname: '127.0.0.1', serverKeyId: keyA },
      { hostname: '127.0.0.1', serverKeyId: keyB },
    ];
    expect(verifyWithPins(pins, '127.0.0.1', certA)).toBe(0);
    expect(verifyWithPins(pins, '127.0.0.1', certB)).toBe(0);
    expect(verifyWithPins(pins, '127.0.0.1', certC)).toBe(-2);
  });

  it('never holds more than two pins; duplicates count once', () => {
    const a = { hostname: 'A.example', serverKeyId: keyA };
    expect(normalizePins([a, { hostname: 'a.example', serverKeyId: keyA }])).toEqual([{ hostname: 'a.example', serverKeyId: keyA }]);
    expect(normalizePins([a, { hostname: 'b.example', serverKeyId: keyB }])).toHaveLength(2);
    expect(() => normalizePins([a, { hostname: 'b.example', serverKeyId: keyB }, { hostname: 'c.example', serverKeyId: keyC }])).toThrow(/at most 2/);
  });

  it('a pin taken away (or replaced) withdraws trust; one that only joins does not', () => {
    const a = { hostname: 'a.example', serverKeyId: keyA };
    const b = { hostname: 'b.example', serverKeyId: keyB };
    expect(pinsWithdrawn([a], [a, b])).toBe(false);
    expect(pinsWithdrawn([], [a])).toBe(false);
    expect(pinsWithdrawn([a, b], [a])).toBe(true);
    expect(pinsWithdrawn([a], [])).toBe(true);
    expect(pinsWithdrawn([a], [{ hostname: 'a.example', serverKeyId: keyB }])).toBe(true);
  });
});

describe('renderer pinning on a session', () => {
  type Proc = Parameters<PinSession['setCertificateVerifyProc']>[0];
  let proc: Proc;
  let closed: number;
  const verify = (hostname: string, pem: string) => {
    let result: number | undefined;
    const request = { hostname, certificate: { data: pem } } as Parameters<NonNullable<Proc>>[0];
    proc!(request, (r) => {
      result = r;
    });
    return result;
  };

  beforeEach(() => {
    closed = 0;
    installRendererPinning({
      setCertificateVerifyProc: (p) => {
        proc = p;
      },
      closeAllConnections: async () => {
        closed++;
      },
    });
  });

  it('starts unpinned, then follows the pins and closes connections whenever one is withdrawn', async () => {
    expect(verify('127.0.0.1', certA)).toBe(-3);
    await setRendererPins([{ hostname: '127.0.0.1', serverKeyId: keyA }]);
    expect(verify('127.0.0.1', certA)).toBe(0);
    expect(verify('127.0.0.1', certB)).toBe(-2);
    expect(closed).toBe(0); // nothing was trusted before: nothing to close
    await setRendererPins([]);
    expect(verify('127.0.0.1', certA)).toBe(-3);
    expect(closed).toBe(1);
  });

  it("a call on A while B is on screen: B joins without closing anything (the call's LiveKit stays), leaving B closes", async () => {
    const a = { hostname: 'a.example', serverKeyId: keyA };
    const b = { hostname: 'b.example', serverKeyId: keyB };
    await setRendererPins([a]);
    await setRendererPins([a]); // the same set (going Home from A during the call): nothing changes
    await setRendererPins([b, a]);
    expect(verify('a.example', certA)).toBe(0);
    expect(verify('b.example', certB)).toBe(0);
    expect(closed).toBe(0);
    await setRendererPins([a]);
    expect(verify('b.example', certB)).toBe(-3);
    expect(verify('a.example', certA)).toBe(0);
    expect(closed).toBe(1);
  });

  it('refuses a third pin and keeps the previous ones', async () => {
    const a = { hostname: 'a.example', serverKeyId: keyA };
    const b = { hostname: 'b.example', serverKeyId: keyB };
    await setRendererPins([a, b]);
    await expect(setRendererPins([a, b, { hostname: 'c.example', serverKeyId: keyC }])).rejects.toThrow(/at most 2/);
    expect(verify('c.example', certC)).toBe(-3);
    expect(verify('a.example', certA)).toBe(0);
  });

  it('copies the pin, so later mutation by the caller changes nothing', async () => {
    const pin = { hostname: '127.0.0.1', serverKeyId: keyA };
    await setRendererPins([pin]);
    pin.hostname = '10.0.0.1';
    expect(verify('127.0.0.1', certA)).toBe(0);
  });

  it('refuses to pin before installRendererPinning()', async () => {
    vi.resetModules();
    const fresh = await import('../../src/main/pinning.js');
    await expect(fresh.setRendererPins([])).rejects.toThrow(/installRendererPinning/);
  });
});

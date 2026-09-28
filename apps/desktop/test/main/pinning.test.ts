import { X509Certificate } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCertificate, serverKeyIdFromDer } from '../../../server/src/tls/certificate.js';
import {
  installRendererPinning,
  serverKeyIdFromCertificate,
  setRendererPin,
  verifyWithPin,
  type PinSession,
} from '../../src/main/pinning.js';

let certA: string;
let certB: string;
let keyA: string;
beforeAll(async () => {
  certA = (await generateCertificate()).certPem;
  certB = (await generateCertificate()).certPem;
  keyA = serverKeyIdFromDer(new X509Certificate(certA).raw);
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

  it('starts unpinned, then follows every pin change and closes connections each time', async () => {
    expect(verify('127.0.0.1', certA)).toBe(-3);
    await setRendererPin({ hostname: '127.0.0.1', serverKeyId: keyA });
    expect(verify('127.0.0.1', certA)).toBe(0);
    expect(verify('127.0.0.1', certB)).toBe(-2);
    await setRendererPin(null);
    expect(verify('127.0.0.1', certA)).toBe(-3);
    expect(closed).toBe(2);
  });

  it('copies the pin, so later mutation by the caller changes nothing', async () => {
    const pin = { hostname: '127.0.0.1', serverKeyId: keyA };
    await setRendererPin(pin);
    pin.hostname = '10.0.0.1';
    expect(verify('127.0.0.1', certA)).toBe(0);
  });

  it('refuses to pin before installRendererPinning()', async () => {
    vi.resetModules();
    const fresh = await import('../../src/main/pinning.js');
    await expect(fresh.setRendererPin(null)).rejects.toThrow(/installRendererPinning/);
  });
});

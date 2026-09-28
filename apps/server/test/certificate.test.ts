import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataPaths } from '../src/config/paths.js';
import { generateCertificate, loadOrCreateCertificate, readCertificate, serverKeyIdFromDer } from '../src/tls/certificate.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-cert-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('generateCertificate', () => {
  it('has the exact profile BoringSSL and the pin need (spec §3.2)', async () => {
    const { certPem } = await generateCertificate(new Date('2026-01-01T00:00:00Z'));
    const cert = new x509.X509Certificate(certPem);
    expect(cert.subject).toBe('CN=GhostLink');
    expect(cert.issuer).toBe('CN=GhostLink');
    expect(cert.publicKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(cert.signatureAlgorithm).toMatchObject({ name: 'ECDSA', hash: { name: 'SHA-256' } });

    const ku = cert.getExtension(x509.KeyUsagesExtension)!;
    expect(ku.critical).toBe(true);
    expect(ku.usages).toBe(x509.KeyUsageFlags.digitalSignature);
    const bc = cert.getExtension(x509.BasicConstraintsExtension)!;
    expect(bc.ca).toBe(false);
    expect([...cert.getExtension(x509.ExtendedKeyUsageExtension)!.usages]).toEqual([x509.ExtendedKeyUsage.serverAuth]);

    const node = new X509Certificate(certPem);
    expect(node.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
    expect(node.serialNumber).toMatch(/^[0-9A-F]{32}$/); // 16 bytes
    expect(Number.parseInt(node.serialNumber.slice(0, 2), 16)).toBeLessThan(0x80); // positive
    const years = (node.validToDate.getTime() - node.validFromDate.getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.99);
    expect(node.validFromDate.getTime()).toBeLessThan(new Date('2026-01-01T00:00:00Z').getTime()); // skew margin
  });

  it('uses a fresh random serial and key every time', async () => {
    const a = new X509Certificate((await generateCertificate()).certPem);
    const b = new X509Certificate((await generateCertificate()).certPem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
    expect(serverKeyIdFromDer(a.raw)).not.toBe(serverKeyIdFromDer(b.raw));
  });
});

describe('serverKeyIdFromDer', () => {
  it('hashes the SPKI DER, not the raw EC point nor the whole certificate', async () => {
    const { certPem } = await generateCertificate();
    const cert = new X509Certificate(certPem);
    const id = serverKeyIdFromDer(cert.raw);
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    expect(id).toBe(createHash('sha256').update(spki).digest('base64url'));
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(createHash('sha256').update(cert.raw).digest('base64url'));
  });
});

describe('loadOrCreateCertificate', () => {
  it('creates the pair once, then reloads the same serverKeyId', async () => {
    const first = await loadOrCreateCertificate(dir);
    const second = await loadOrCreateCertificate(dir);
    expect(second.serverKeyId).toBe(first.serverKeyId);
    expect(second.certPem).toBe(first.certPem);
    expect(readCertificate(dir)?.serverKeyId).toBe(first.serverKeyId);
  });

  it.skipIf(process.platform === 'win32')('stores the private key as 0600', async () => {
    await loadOrCreateCertificate(dir);
    expect(statSync(dataPaths(dir).keyFile).mode & 0o777).toBe(0o600);
  });

  it('serves TLS whose peer SPKI hash equals serverKeyId (what clients pin)', async () => {
    const { certPem, keyPem, serverKeyId } = await loadOrCreateCertificate(dir);
    const server = createServer({ cert: certPem, key: keyPem }, (_req, res) => res.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const socket = connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, rejectUnauthorized: false });
    await new Promise<void>((r) => socket.once('secureConnect', () => r()));
    const peer = new X509Certificate(socket.getPeerCertificate(true).raw);
    expect(serverKeyIdFromDer(peer.raw)).toBe(serverKeyId);
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses to regenerate when only one of the two files exists', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ghostlink-cert-half-'));
    try {
      await loadOrCreateCertificate(other);
      unlinkSync(dataPaths(other).certFile);
      await expect(loadOrCreateCertificate(other)).rejects.toThrow(/Incomplete TLS material/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a key that does not match the certificate', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ghostlink-cert-mismatch-'));
    try {
      await loadOrCreateCertificate(other);
      writeFileSync(dataPaths(other).keyFile, (await generateCertificate()).keyPem);
      expect(() => readCertificate(other)).toThrow(/does not match/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

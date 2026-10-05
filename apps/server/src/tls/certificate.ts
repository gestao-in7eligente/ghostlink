// reflect-metadata MUST be imported before @peculiar/x509 (2.x throws without the polyfill).
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createHash, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dataPaths, ensureDataDirs, writeFileAtomic, writeSecretFile } from '../config/paths.js';

export interface ServerCertificate {
  certPem: string;
  keyPem: string;
  serverKeyId: string;
}

const EC_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const VALIDITY_YEARS = 10;
const CLOCK_SKEW_MS = 5 * 60_000;

/** serverKeyId = base64url(SHA-256(SPKI DER)) — never the raw EC point, never the whole-cert hash (spec §3.2). */
export function serverKeyIdFromDer(der: Uint8Array): string {
  const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url');
}

/**
 * Self-signed ECDSA P-256 certificate (spec §3.2): 16-byte positive serial,
 * CN=GhostLink, CA:false, KeyUsage=digitalSignature (critical — BoringSSL refuses
 * the cert otherwise), EKU serverAuth, SAN localhost/127.0.0.1, 10-year validity.
 */
export async function generateCertificate(now: Date = new Date()): Promise<{ certPem: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(EC_ALGORITHM, true, ['sign', 'verify']);
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive and exactly 16 bytes in DER
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_MS);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: 'CN=GhostLink',
    notBefore,
    notAfter,
    signingAlgorithm: EC_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
      ], false),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  return { certPem: cert.toString('pem'), keyPem };
}

/** Reads data/tls/server.{crt,key}. Returns null when neither exists; throws when only one does or they do not match. */
export function readCertificate(dataDir: string): ServerCertificate | null {
  const p = dataPaths(dataDir);
  const hasCert = existsSync(p.certFile);
  const hasKey = existsSync(p.keyFile);
  if (!hasCert && !hasKey) return null;
  if (hasCert !== hasKey) {
    // Never regenerate here: a new key would change the serverKeyId and break every pin and invite.
    throw new Error(`Incomplete TLS material in ${p.tlsDir}: server.crt and server.key must both exist. Restore them from a backup.`);
  }
  const certPem = readFileSync(p.certFile, 'utf8');
  const keyPem = readFileSync(p.keyFile, 'utf8');
  const cert = new X509Certificate(certPem);
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error(`TLS key in ${p.keyFile} does not match ${p.certFile}.`);
  }
  return { certPem, keyPem, serverKeyId: serverKeyIdFromDer(cert.raw) };
}

export async function loadOrCreateCertificate(dataDir: string): Promise<ServerCertificate> {
  const existing = readCertificate(dataDir);
  if (existing) return existing;
  const p = ensureDataDirs(dataDir);
  const generated = await generateCertificate();
  writeSecretFile(p.keyFile, generated.keyPem);
  writeFileAtomic(p.certFile, generated.certPem);
  const created = readCertificate(dataDir);
  if (!created) throw new Error('certificate vanished right after being written');
  return created;
}

// Issues an Enterprise license (spec §1), on the owner's PC, with Claude:
//
//   node scripts/issue-license.mjs --key "D:\GhostLink Licencas\ghostlink-license-key.pem" \
//     --company "TC Flag" --server <serverKeyId> --until 2027-10-02
//
// <serverKeyId>: Configurações do servidor → Enterprise → "Identidade do servidor". --until: the last
// day it is valid (São Paulo time). Prints the license (GLE1.…) for the owner to paste in that tab.
// Refuses a key file inside a git work tree and a key that is not LICENSE_PUBLIC_KEY's
// (--expect-public-key overrides the expected key: tests only).
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { embeddedLicensePublicKey, enclosingWorkTree, encodeLicense, endOfDaySaoPaulo } from './lib/license.mjs';
import { rawPublicKey } from './lib/releaseKey.mjs';

/**
 * @param {string[]} argv
 * @param {string} name
 */
function arg(argv, name) {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** @param {string[]} argv */
function main(argv) {
  const keyPath = arg(argv, '--key');
  const company = arg(argv, '--company')?.trim();
  const server = arg(argv, '--server');
  const until = arg(argv, '--until');
  if (!keyPath || !company || !server || !until) {
    console.error('usage: node scripts/issue-license.mjs --key <license key .pem> --company <name> --server <serverKeyId> --until YYYY-MM-DD');
    return 2;
  }
  if (company.length > 100) {
    console.error('--company: at most 100 characters');
    return 2;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(server)) {
    console.error('--server: the server identity (43 characters, Configurações do servidor → Enterprise)');
    return 2;
  }
  if (enclosingWorkTree(keyPath) !== null) {
    console.error('refusing: the key file is inside a git work tree');
    return 2;
  }
  let expiresAt;
  try {
    expiresAt = endOfDaySaoPaulo(until);
  } catch (e) {
    console.error(`--until: ${/** @type {Error} */ (e).message}`);
    return 2;
  }
  const now = Date.now();
  if (expiresAt <= now) {
    console.error('--until is in the past');
    return 2;
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: readFileSync(keyPath, 'utf8'), format: 'pem' });
  } catch {
    console.error('cannot read the license key (a PEM private key)');
    return 1;
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    console.error('the license key must be an Ed25519 key');
    return 1;
  }
  let expected;
  try {
    expected = arg(argv, '--expect-public-key') ?? embeddedLicensePublicKey(fileURLToPath(new URL('..', import.meta.url)));
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    return 1;
  }
  if (rawPublicKey(privateKey) !== expected) {
    console.error('this key is not the one in LICENSE_PUBLIC_KEY (packages/shared/src/license.ts)');
    return 1;
  }
  console.log(encodeLicense({ company, serverKeyId: server, issuedAt: now, expiresAt }, privateKey));
  return 0;
}

process.exitCode = main(process.argv.slice(2));

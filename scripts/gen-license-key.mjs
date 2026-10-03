// Makes the Enterprise LICENSE key (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): a
// new Ed25519 key, separate from the release key. Run once, on the owner's PC:
//
//   node scripts/gen-license-key.mjs --private-key-out "D:\GhostLink Licencas\ghostlink-license-key.pem"
//
// It prints only LICENSE_PUBLIC_KEY=<raw base64url> (for packages/shared/src/license.ts). The private
// key goes only to --private-key-out (created 0600, never overwritten), which must be outside every
// git work tree. It is never printed. The owner keeps a backup copy wherever they choose.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { enclosingWorkTree } from './lib/license.mjs';
import { generateReleaseKey } from './lib/releaseKey.mjs';

/** @param {string[]} argv */
function main(argv) {
  const index = argv.indexOf('--private-key-out');
  const out = index >= 0 ? argv[index + 1] : undefined;
  if (out === undefined || out.startsWith('--')) {
    console.error('usage: node scripts/gen-license-key.mjs --private-key-out <file outside any git repository>');
    return 2;
  }
  const tree = enclosingWorkTree(out);
  if (tree !== null) {
    console.error(`refusing: ${out} is inside the git work tree ${tree}. The license private key never goes near a repository.`);
    return 2;
  }
  // An Ed25519 keypair, the same helper as the release key (a new, separate key).
  const { publicKey, privateKeyPem } = generateReleaseKey();
  try {
    writeFileSync(out, privateKeyPem, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    console.error(code === 'EEXIST' ? `${out} already exists; refusing to overwrite it.` : `cannot write ${out} (${code ?? 'error'}).`);
    return 1;
  }
  console.log(`LICENSE_PUBLIC_KEY=${publicKey}`);
  console.log(`Private key written to ${out}. Keep a backup copy somewhere safe; it never goes into the repository.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

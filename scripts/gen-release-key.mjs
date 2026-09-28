// Generates the Ed25519 release keypair (spec §15). Run once, by a maintainer, on a trusted machine:
//
//   node scripts/gen-release-key.mjs --private-key-out <file outside the repo>
//   gh secret set RELEASE_ED25519_PRIVATE_KEY_PEM --env release --repo <owner>/ghostlink < <file>
//   then delete <file>.
//
// It prints the raw public key (base64url) for RELEASE_PUBLIC_KEY in packages/shared/src/release.ts
// and for scripts/install.sh. The PKCS#8 PEM private key goes to --private-key-out (created 0600,
// never overwritten); without that option it is printed to stdout. It must never reach the
// repository or a log: its only home is the `release` GitHub Environment.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { generateReleaseKey, publicKeyPem } from './lib/releaseKey.mjs';

/** @param {string[]} argv */
function main(argv) {
  const index = argv.indexOf('--private-key-out');
  const out = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && (out === undefined || out.startsWith('--'))) {
    console.error('usage: node scripts/gen-release-key.mjs [--private-key-out <file>]');
    return 2;
  }
  const { publicKey, privateKeyPem } = generateReleaseKey();
  if (out !== undefined) {
    try {
      // 'wx': fail instead of overwriting a key that may be the only copy.
      writeFileSync(out, privateKeyPem, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      console.error(code === 'EEXIST' ? `${out} already exists; refusing to overwrite it.` : `cannot write ${out} (${code ?? 'error'}).`);
      return 1;
    }
  }
  console.log(`RELEASE_PUBLIC_KEY=${publicKey}`);
  console.log('\nSame key as PEM (openssl pkeyutl -verify -pubin -inkey …):');
  console.log(publicKeyPem(publicKey));
  if (out === undefined) {
    console.log('Private key (store it in the `release` environment, then clear this terminal):');
    console.log(privateKeyPem);
  } else {
    console.log(`Private key written to ${out}. Store it in the \`release\` environment, then delete the file.`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));

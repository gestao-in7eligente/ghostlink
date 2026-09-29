// Signs release files with the Ed25519 release key (spec §15), in the `release` environment only:
//
//   RELEASE_ED25519_PRIVATE_KEY_PEM=… node scripts/sign-release.mjs release/*
//
// Writes `<file>.ed25519` (raw 64-byte signature over the file bytes) next to every file given,
// skipping existing .ed25519 files. It first checks that the key belongs to RELEASE_PUBLIC_KEY in
// packages/shared/src/release.ts, so a mismatched secret stops the release before anything ships.
// The key is read from the environment only and never printed.
import { basename } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { embeddedPublicKey, signFiles } from './lib/releaseKey.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** @param {string[]} files */
function main(files) {
  const pem = process.env.RELEASE_ED25519_PRIVATE_KEY_PEM;
  if (!pem) {
    console.error('sign-release: RELEASE_ED25519_PRIVATE_KEY_PEM is not set (it exists only in the `release` environment).');
    return 1;
  }
  if (files.length === 0) {
    console.error('usage: node scripts/sign-release.mjs <file>...');
    return 2;
  }
  try {
    for (const written of signFiles(files, pem, embeddedPublicKey(repoRoot))) console.log(`signed ${basename(written)}`);
    return 0;
  } catch (e) {
    console.error(`sign-release: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));

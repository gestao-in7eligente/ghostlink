// Checks a signed release directory against RELEASE_PUBLIC_KEY before it is published (spec §15):
//
//   node scripts/verify-release.mjs release 0.1.0
//
// The app installs an update only when checksums-sha256.txt is signed by the release key and lists
// GhostLink-Setup-<version>.exe with its hash; install.sh does the same for ghostlink-server-<version>.tgz.
// This runs those checks in release.yml, so a release that no client would accept never ships.
// Node built-ins only (it runs in the job that holds the key, but needs no secret).
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyReleaseDir } from './lib/releaseFiles.mjs';
import { embeddedPublicKey } from './lib/releaseKey.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const [dir, version] = process.argv.slice(2);
if (dir === undefined || version === undefined) {
  console.error('usage: node scripts/verify-release.mjs <release dir> <version>');
  process.exit(2);
}
try {
  const names = await verifyReleaseDir(dir, version, embeddedPublicKey(repoRoot));
  console.log(`verify-release: checksums-sha256.txt is signed by the release key and lists ${names.join(' and ')}`);
} catch (e) {
  console.error(`verify-release: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}

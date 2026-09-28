// Writes <dir>/checksums-sha256.txt for every release file in <dir> (spec §15), in sha256sum format:
//
//   node scripts/checksums.mjs release
//
// Users verify with `sha256sum --ignore-missing -c checksums-sha256.txt` (Windows: Get-FileHash),
// after checking the file itself with cosign (checksums-sha256.txt.sigstore.json) or Ed25519
// (checksums-sha256.txt.ed25519).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { CHECKSUMS_FILE, checksumsFor } from './lib/releaseFiles.mjs';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node scripts/checksums.mjs <release dir>');
  process.exit(2);
}
const text = await checksumsFor(dir);
writeFileSync(join(dir, CHECKSUMS_FILE), text);
process.stdout.write(text);

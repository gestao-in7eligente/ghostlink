// Builds the VPS server package (spec §10, §15) after `npm run build -w @ghostlink/server`:
//
//   node scripts/pack-server.mjs <out dir>
//
// Writes <out>/ghostlink-server-<version>.tgz (dist/cli.js, dist/migrations/, package.json,
// install.sh, LICENSE; extracted as-is into /opt/ghostlink) and <out>/install.sh, which is also
// published on its own so a VPS can fetch the installer from the latest release. The archive is
// reproducible: its timestamps come from SOURCE_DATE_EPOCH (release.yml sets the commit time).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serverPackageEntries, tarGz } from './lib/releaseFiles.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (out === undefined) {
  console.error('usage: node scripts/pack-server.mjs <out dir>');
  process.exit(2);
}
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000));
if (!Number.isSafeInteger(epoch) || epoch <= 0) {
  console.error('pack-server: SOURCE_DATE_EPOCH must be a positive integer');
  process.exit(2);
}
try {
  const { version, entries } = serverPackageEntries({ repoRoot });
  mkdirSync(out, { recursive: true });
  const name = `ghostlink-server-${version}.tgz`;
  writeFileSync(join(out, name), tarGz(entries, epoch));
  copyFileSync(join(repoRoot, 'scripts', 'install.sh'), join(out, 'install.sh'));
  console.log(`pack-server: wrote ${name} (${entries.map((e) => e.name).join(', ')}) and install.sh`);
} catch (e) {
  console.error(`pack-server: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}

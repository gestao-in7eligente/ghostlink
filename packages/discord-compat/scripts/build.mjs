// Builds @ghostlink/discord-compat (bots spec §4) into dist/, which is what the .tgz ships:
//
//   dist/esm/index.js + *.d.ts   (import)
//   dist/cjs/index.js + *.d.ts   (require; dist/cjs/package.json says "commonjs")
//
// esbuild bundles src/ with @ghostlink/shared (a private workspace package, not on npm) into each
// format; ws and zod stay external, installed as the package's dependencies. tsc writes the
// declarations, which must not mention @ghostlink/shared: a bot installing the .tgz has no such package.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: Object.keys(pkg.dependencies),
  define: { __GHOSTLINK_COMPAT_VERSION__: JSON.stringify(pkg.version) },
  // Class names appear in GhostLinkUnsupported messages; bundling must not rename them.
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...common, format: 'esm', outfile: 'dist/esm/index.js' });
await build({ ...common, format: 'cjs', outfile: 'dist/cjs/index.js' });
writeFileSync(join(dist, 'cjs', 'package.json'), '{ "type": "commonjs" }\n');

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

/** @param {string} dir @returns {string[]} */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}
const types = join(dist, 'types');
for (const file of files(types)) {
  if (/@ghostlink\/shared|from ["']zod["']/.test(readFileSync(file, 'utf8'))) {
    console.error(`build: ${file} refers to @ghostlink/shared or zod; a bot that installs the package has neither`);
    process.exit(1);
  }
}
// The same declarations for both formats: under dist/cjs they read as CommonJS (its package.json).
for (const format of ['esm', 'cjs']) cpSync(types, join(dist, format), { recursive: true });
rmSync(types, { recursive: true, force: true });

mkdirSync(dist, { recursive: true });
copyFileSync(join(root, '..', '..', 'LICENSE'), join(dist, 'LICENSE'));
console.log(`Built @ghostlink/discord-compat ${pkg.version} (dist/esm, dist/cjs)`);

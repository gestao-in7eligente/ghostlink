// Bundles the VPS CLI into dist/cli.js (single file + dist/migrations/*.sql), plus the native
// add-on of @livekit/rtc-node (the Ghost DJ's voice) in dist/node_modules/.
import { build } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

rmSync(dist, { recursive: true, force: true });

/**
 * @livekit/rtc-node is bundled like any dependency, except its native code: the platform packages
 * `@livekit/rtc-ffi-bindings-<os>-<cpu>` (one .node file each, loaded by rtc-ffi-bindings' napi
 * loader inside try/catch) stay external. Their package.json and .node go to dist/node_modules/,
 * where the bundle's require() finds them; the VPS package adds the Linux ones this machine lacks
 * (scripts/lib/rtcNative.mjs).
 */
const NATIVE_EXTERNALS = ['@livekit/rtc-ffi-bindings-*', '*.node'];


await build({
  absWorkingDir: root,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // ws probes these optional native add-ons inside try/catch.
  external: ['bufferutil', 'utf-8-validate', ...NATIVE_EXTERNALS],
  // CommonJS dependencies (ws, reflect-metadata, tsyringe…) call require(); ESM output needs a real one.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __ghostlinkCreateRequire } from 'node:module';",
      "import { dirname as __ghostlinkDirname } from 'node:path';",
      "import { fileURLToPath as __ghostlinkFileURLToPath } from 'node:url';",
      'const require = __ghostlinkCreateRequire(import.meta.url);',
      'const __filename = __ghostlinkFileURLToPath(import.meta.url);',
      'const __dirname = __ghostlinkDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
  // The napi loader tries every platform's file next to itself first (absent: caught at run time).
  logOverride: { 'require-resolve-not-external': 'silent' },
});

// database.ts reads migrations from new URL('./migrations/', import.meta.url) = dist/migrations/ in the bundle.
cpSync(fileURLToPath(new URL('../src/db/migrations/', import.meta.url)), fileURLToPath(new URL('../dist/migrations/', import.meta.url)), {
  recursive: true,
});

// The rtc-node native packages npm installed here (this machine's platform, plus any other present).
const fromRtcNode = createRequire(createRequire(import.meta.url).resolve('@livekit/rtc-node'));
const scope = dirname(dirname(fromRtcNode.resolve('@livekit/rtc-ffi-bindings/package.json')));
const copied = [];
for (const name of readdirSync(scope)) {
  if (!/^rtc-ffi-bindings-[a-z0-9-]+$/.test(name)) continue;
  const from = join(scope, name);
  const files = readdirSync(from).filter((f) => f === 'package.json' || f.endsWith('.node'));
  if (!files.includes('package.json') || !files.some((f) => f.endsWith('.node'))) continue;
  const to = join(dist, 'node_modules', '@livekit', name);
  mkdirSync(to, { recursive: true });
  for (const f of files) copyFileSync(join(from, f), join(to, f));
  copied.push(name);
}

if (process.platform !== 'win32') chmodSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 0o755);

console.log(`Built apps/server/dist/cli.js${copied.length > 0 ? ` (+ @livekit/${copied.join(', @livekit/')})` : ''}`);
if (!existsSync(join(dist, 'cli.js'))) process.exit(1);

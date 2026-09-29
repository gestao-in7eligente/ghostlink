// Bundles the VPS CLI into dist/cli.js (single file + dist/migrations/*.sql).
import { build } from 'esbuild';
import { chmodSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // ws probes these optional native add-ons inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (ws, reflect-metadata, tsyringe…) call require(); ESM output needs a real one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __ghostlinkCreateRequire } from 'node:module';\nconst require = __ghostlinkCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// database.ts reads migrations from new URL('./migrations/', import.meta.url) = dist/migrations/ in the bundle.
cpSync(fileURLToPath(new URL('../src/db/migrations/', import.meta.url)), fileURLToPath(new URL('../dist/migrations/', import.meta.url)), {
  recursive: true,
});

if (process.platform !== 'win32') chmodSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 0o755);

console.log('Built apps/server/dist/cli.js');

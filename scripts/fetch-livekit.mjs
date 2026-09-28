// Downloads the pinned LiveKit server release and installs the verified binary where
// electron-builder (extraResources) and the dev/test server look for it:
//   apps/desktop/resources/livekit/<os>-<arch>/livekit-server[.exe]
//
// Usage: node scripts/fetch-livekit.mjs [--target win-x64|linux-x64|linux-arm64|current|all]
//                                       [--cache <dir>] [--out <dir>]
//   --target  default "current" (this machine; a no-op on macOS, which has no official binary)
//   --cache   folder with previously downloaded archives (default $GHOSTLINK_LIVEKIT_CACHE);
//             a cached archive is used only when its SHA-256 matches the pin
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LIVEKIT_TARGETS, fetchLivekit, targetFor } from './lib/livekit.mjs';

const { values } = parseArgs({
  options: { target: { type: 'string', default: 'current' }, cache: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});

const outDir = resolve(values.out ?? fileURLToPath(new URL('../apps/desktop/resources/livekit/', import.meta.url)));
const cacheDir = values.cache ?? process.env.GHOSTLINK_LIVEKIT_CACHE;

/** @type {string[]} */
let targets;
if (values.target === 'all') targets = Object.keys(LIVEKIT_TARGETS);
else if (values.target === 'current') {
  const current = targetFor(process.platform, process.arch);
  if (!current) {
    console.log(`No official LiveKit binary for ${process.platform}-${process.arch}; voice will be unavailable in this build.`);
    process.exit(0);
  }
  targets = [current];
} else if (values.target && Object.hasOwn(LIVEKIT_TARGETS, values.target)) targets = [values.target];
else {
  console.error(`Unknown --target ${values.target}. Use one of: current, all, ${Object.keys(LIVEKIT_TARGETS).join(', ')}.`);
  process.exit(2);
}

try {
  for (const target of targets) await fetchLivekit({ target, outDir, cacheDir: cacheDir ? resolve(cacheDir) : undefined });
} catch (e) {
  console.error(`fetch-livekit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

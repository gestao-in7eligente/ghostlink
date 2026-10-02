import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineProject({
  // What scripts/build.mjs defines for the bundles.
  define: { __GHOSTLINK_COMPAT_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    // The example imports the package by name, as a bot would; the tests run it on the source.
    alias: { '@ghostlink/discord-compat': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  test: {
    name: 'discord-compat',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

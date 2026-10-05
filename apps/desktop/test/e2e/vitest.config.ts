import { defineConfig } from 'vitest/config';

// End-to-end runs (npm run test:e2e): real Electron instances driven by Playwright.
// Not part of `npm test`; the desktop project's config only includes test/**/*.test.ts.
export default defineConfig({
  test: {
    name: 'desktop-e2e',
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

// Plan 1b appends 'apps/desktop' once that directory exists:
// Vitest 5 refuses to start when a listed project directory is missing.
export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/server'],
  },
});

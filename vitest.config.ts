import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 'scripts' is the tooling project: smoke runner, packaging and CI policy tests.
    projects: ['packages/shared', 'apps/server', 'apps/desktop', 'scripts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 'scripts' is the tooling project: smoke runner, packaging and CI policy tests.
    projects: ['packages/shared', 'packages/discord-compat', 'apps/server', 'apps/desktop', 'scripts', 'integrations/hermes-agent'],
  },
});

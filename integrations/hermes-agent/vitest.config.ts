import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'hermes-agent',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 20_000,
  },
});

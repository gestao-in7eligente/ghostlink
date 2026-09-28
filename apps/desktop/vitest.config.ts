import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Several suites talk to real servers over TLS.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

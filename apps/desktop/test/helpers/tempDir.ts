import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** A fresh temporary directory per test, removed afterwards. Read `.path` inside tests/hooks. */
export function useTempDir(prefix = 'ghostlink-desktop-'): { readonly path: string } {
  let current = '';
  beforeEach(() => {
    current = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    rmSync(current, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    get path() {
      return current;
    },
  };
}

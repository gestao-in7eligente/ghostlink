import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CRYPTO_LABELS } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';

const nsh = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/installer.nsh', import.meta.url)), 'utf8');
const statements = nsh.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith(';'));

describe('apps/desktop/build/installer.nsh', () => {
  it('defines only the customUnInstall hook', () => {
    expect(statements.filter((l) => l.startsWith('!macro '))).toEqual(['!macro customUnInstall']);
    expect(statements.at(-1)).toBe('!macroend');
  });

  it('deletes the per-user ghostlink:// handler, except when an update runs the old uninstaller', () => {
    // electron-builder runs the previous uninstaller with --updated during an update; deleting the
    // key then would break deep links until the new version starts and registers it again.
    expect(statements).toEqual([
      '!macro customUnInstall',
      '${ifNot} ${isUpdated}',
      `DeleteRegKey HKCU "Software\\Classes\\${CRYPTO_LABELS.scheme}"`,
      '${endIf}',
      '!macroend',
    ]);
  });

  it('never touches machine-wide keys or user data (identity.bin lives in %APPDATA%)', () => {
    expect(nsh).not.toMatch(/HKLM|HKEY_LOCAL_MACHINE|\$APPDATA|\$LOCALAPPDATA|RMDir|Delete\s/i);
  });
});

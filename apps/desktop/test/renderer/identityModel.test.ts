import { beforeEach, describe, expect, it } from 'vitest';
import {
  backupPasswordProblem,
  closeIdentityDialog,
  importConfirmationsNeeded,
  openBackupExport,
  openBackupImport,
  openIdentitySettings,
  useIdentityUi,
} from '../../src/renderer/features/identity/identityModel.js';

describe('backupPasswordProblem (spec §3.4)', () => {
  it.each([
    ['', '', 'short'],
    ['1234567', '1234567', 'short'],
    ['😀😀😀😀😀😀😀', '😀😀😀😀😀😀😀', 'short'], // 7 characters, 14 UTF-16 units
    ['12345678', '12345679', 'mismatch'],
    ['x'.repeat(1_025), 'x'.repeat(1_025), 'long'],
    ['12345678', '12345678', null],
    ['senha forte', 'senha forte', null],
  ])('%j / %j → %s', (password, confirm, problem) => {
    expect(backupPasswordProblem(password, confirm)).toBe(problem);
  });
});

describe('importConfirmationsNeeded', () => {
  it('asks twice only when an identity would be replaced', () => {
    expect(importConfirmationsNeeded('ready')).toBe(2);
    expect(importConfirmationsNeeded('none')).toBe(0);
    expect(importConfirmationsNeeded('locked')).toBe(0);
  });
});

describe('identity dialogs', () => {
  beforeEach(() => closeIdentityDialog());
  it('open and close from anywhere', () => {
    openIdentitySettings();
    expect(useIdentityUi.getState().dialog).toBe('settings');
    openBackupExport();
    expect(useIdentityUi.getState().dialog).toBe('export');
    openBackupImport();
    expect(useIdentityUi.getState().dialog).toBe('import');
    closeIdentityDialog();
    expect(useIdentityUi.getState().dialog).toBe('closed');
  });
});

import { create } from 'zustand';
import type { IdentityStatus } from '../../../shared/ipcTypes.js';

/** Must match BACKUP_PASSWORD_MIN in main/backup.ts (the main process checks again). */
export const BACKUP_PASSWORD_MIN = 8;
export const BACKUP_PASSWORD_MAX = 1_024;

export type PasswordProblem = 'short' | 'long' | 'mismatch';

/** Why this export password cannot be used yet, or null. Length counts characters, not bytes. */
export function backupPasswordProblem(password: string, confirm: string): PasswordProblem | null {
  const length = [...password.normalize('NFC')].length;
  if (length < BACKUP_PASSWORD_MIN) return 'short';
  if (password.length > BACKUP_PASSWORD_MAX) return 'long';
  if (password !== confirm) return 'mismatch';
  return null;
}

/**
 * spec §3.4: importing over an existing identity needs two confirmations; on a device
 * without one (or with a locked one, which is kept aside as .bak) it does not.
 */
export function importConfirmationsNeeded(status: IdentityStatus): 0 | 2 {
  return status === 'ready' ? 2 : 0;
}

export type IdentityDialog = 'closed' | 'settings' | 'export' | 'import';

interface IdentityUiStore {
  dialog: IdentityDialog;
  show(dialog: IdentityDialog): void;
}

/** Which identity dialog is open; <IdentityScreens> (mounted by App) renders it. */
export const useIdentityUi = create<IdentityUiStore>()((set) => ({
  dialog: 'closed',
  show: (dialog) => set({ dialog }),
}));

/** User settings → "Identidade" (the future settings screen and the gear can open this). */
export function openIdentitySettings(): void {
  useIdentityUi.getState().show('settings');
}

/** Onboarding "Exportar agora". */
export function openBackupExport(): void {
  useIdentityUi.getState().show('export');
}

/** Onboarding "Já tenho um backup" and the locked-identity screen. */
export function openBackupImport(): void {
  useIdentityUi.getState().show('import');
}

export function closeIdentityDialog(): void {
  useIdentityUi.getState().show('closed');
}

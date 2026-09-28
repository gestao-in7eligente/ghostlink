import type { identity as ptBR } from '../pt-BR/identity.js';

// Typed against pt-BR: a missing or extra key fails the typecheck.
export const identity: Record<keyof typeof ptBR, string> = {
  'identity.settings.title': 'Identity',
  'identity.settings.intro':
    'Your identity is a key kept only on this computer. Without a backup, losing or wiping the computer means losing the identity: you stop being the owner of your servers and need invites again.',
  'identity.settings.open': 'Identity and backup',

  'identity.export.title': 'Export backup',
  'identity.export.body': 'Saves a password-protected .ghostkey file. Keep the file and the password in different places.',
  'identity.export.password': 'Backup password',
  'identity.export.confirm': 'Repeat the password',
  'identity.export.hint': 'At least 8 characters. Without the password nobody can open the file, not even you.',
  'identity.export.submit': 'Choose where to save',
  'identity.export.working': 'Protecting the file…',
  'identity.export.saved': 'Backup saved: {file}',
  'identity.export.short': 'The password needs at least 8 characters.',
  'identity.export.long': 'The password is too long.',
  'identity.export.mismatch': 'The two passwords are different.',

  'identity.import.title': 'Import backup',
  'identity.import.body': 'Restores an identity from a .ghostkey file, for example from another computer.',
  'identity.import.pick': 'Choose file…',
  'identity.import.picked': 'File: {file}',
  'identity.import.password': 'Backup password',
  'identity.import.submit': 'Import',
  'identity.import.working': 'Opening the backup…',
  'identity.import.confirm1':
    'Importing replaces the identity on this computer. With the current identity you lose access to the servers you joined with it, unless you have a backup of it.',
  'identity.import.confirm1Button': 'I understand, continue',
  'identity.import.confirm2': 'Last confirmation: replace the identity now? The old file is kept as identity.bin.bak-….',
  'identity.import.confirm2Button': 'Replace identity',
  'identity.import.done': 'Identity restored.',

  'identity.delete.title': 'Delete from this computer',
  'identity.delete.body': 'Removes your identity from this computer. Without a backup it is lost forever.',
  'identity.delete.exportFirst': 'Export a backup first',
  'identity.delete.start': 'Delete identity',
  'identity.delete.confirm1':
    'Without the identity, servers stop recognizing you: you lose ownership of your servers and need invites to come back. Export a backup first if you want to keep it.',
  'identity.delete.confirm1Button': 'I want to delete it',
  'identity.delete.confirm2': 'Last confirmation: delete the identity from this computer now?',
  'identity.delete.confirm2Button': 'Delete now',

  'identity.onboarding.export': 'Export now',
  'identity.onboarding.import': 'I have a backup',

  'errors.BACKUP_INVALID': 'This file is not a valid .ghostkey backup.',
};

// The Licença tab in the app settings (v0.9).
import type { license as licensePt } from './license.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const license: Record<keyof typeof licensePt, string> = {
  'license.tab': 'License',
  'license.lead': 'Activate your license on this computer with your registration key.',
  'license.key': 'Registration key',
  'license.hint': 'The GLE-… key you received. It activates the license in the app and lets you create servers up to the key limit.',
  'license.activate': 'Activate',
  'license.checking': 'Checking…',
  'license.active.title': 'License active',
  'license.active.company': 'Company: {company}',
  'license.active.quota': '{used} of {max} servers',
  'license.active.until': 'Valid until {date}',
  'license.activeHint': 'You can create servers up to the limit above.',
  'license.remove': 'Remove key',
  'errors.KEY_INVALID': 'Invalid key',
  'errors.KEY_EXPIRED': 'Key expired',
  'errors.KEY_REVOKED': 'Key revoked',
  'errors.KEY_UNREACHABLE': 'Could not reach the license service. Try again.',
};

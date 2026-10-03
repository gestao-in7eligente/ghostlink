// Enterprise and the company Hermes (v0.6.0).
import type { enterprise as enterprisePt } from './enterprise.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const enterprise: Record<keyof typeof enterprisePt, string> = {
  'errors.ENTERPRISE_REQUIRED': 'This only works on an Enterprise server.',
  'errors.LICENSE_INVALID': 'That license is not valid for this server.',
  'errors.LICENSE_EXPIRED': 'That license has expired.',
};

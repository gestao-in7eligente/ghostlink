// The Sites category (v0.7.0).
import type { sites as sitesPt } from './sites.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const sites: Record<keyof typeof sitesPt, string> = {
  'sites.section': 'Sites',
};

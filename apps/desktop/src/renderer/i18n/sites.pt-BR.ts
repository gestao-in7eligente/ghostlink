// The Sites category (v0.7.0, spec 2026-10-03-aba-api-e-sites-design.md §2). Spread into pt-BR.ts;
// sites.en.ts must have exactly the same keys. Track D adds the rest.
export const sites = {
  'sites.section': 'Sites',
};

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const SITES_SAME_IN_BOTH = ['sites.section'] as const;

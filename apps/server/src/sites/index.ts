import type { ServerModule } from '../modules.js';

export const SITES_MODULE_NAME = 'sites';

/** The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2). Register after companyHermes. Track B fills it. */
export interface SitesModule extends ServerModule {
  readonly name: typeof SITES_MODULE_NAME;
}

export function createSitesModule(): SitesModule {
  return { name: SITES_MODULE_NAME };
}

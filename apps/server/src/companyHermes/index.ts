import type { ServerModule } from '../modules.js';

export const COMPANY_HERMES_MODULE_NAME = 'companyHermes';

/**
 * The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2). Register
 * after bots and enterprise.
 */
export interface CompanyHermesModule extends ServerModule {
  readonly name: typeof COMPANY_HERMES_MODULE_NAME;
}

/** Contract stub (Track B). */
export function createCompanyHermesModule(): CompanyHermesModule {
  return { name: COMPANY_HERMES_MODULE_NAME };
}

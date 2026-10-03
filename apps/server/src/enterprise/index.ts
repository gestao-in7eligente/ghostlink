import type { Edition } from '@ghostlink/shared';
import type { ModuleContext, ServerModule } from '../modules.js';

export const ENTERPRISE_MODULE_NAME = 'enterprise';

/**
 * Enterprise servers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): the license,
 * `enterprise.license.set`, the welcome's `enterprise` and the `enterprise.state` event. Register
 * after text, before companyHermes and ghostDj (they read the edition in their init).
 */
export interface EnterpriseModule extends ServerModule {
  readonly name: typeof ENTERPRISE_MODULE_NAME;
  /** 'enterprise' while the stored license is valid for this server, up to 7 days past its validity. */
  readonly edition: Edition;
  /** Runs after each change of edition (pasted, renewed, lapsed); returns the unsubscribe. */
  onChange(listener: (edition: Edition) => void): () => void;
  /** Checks the stored license again now (it also runs at start, when one is pasted and every hour). */
  recheck(): void;
}

export interface EnterpriseModuleOptions {
  /** The license public key (raw base64url); default LICENSE_PUBLIC_KEY. Tests pass a key made for the run. */
  publicKey?: string;
  /** How often the license is checked again; default 1 h. */
  checkEveryMs?: number;
}

/** The enterprise module, or null where a test server runs without it (then the server is normal). */
export function enterpriseOf(ctx: Pick<ModuleContext, 'getModule'>): EnterpriseModule | null {
  try {
    return ctx.getModule<EnterpriseModule>(ENTERPRISE_MODULE_NAME);
  } catch {
    return null;
  }
}

/** Contract stub: always normal (Track A). */
export function createEnterpriseModule(_opts: EnterpriseModuleOptions = {}): EnterpriseModule {
  return { name: ENTERPRISE_MODULE_NAME, edition: 'normal', onChange: () => () => {}, recheck: () => {} };
}

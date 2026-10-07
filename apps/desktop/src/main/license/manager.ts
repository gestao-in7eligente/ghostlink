// The app's own license activation (v0.9): the owner enters the registration key here, the client
// validates it with the license service (/v1/key-info) and unlocks the paid edition features, with the
// server quota the panel defined. The key is stored encrypted (store.ts) and never leaves main; each
// server still activates on its own, which is what enforces the limit.
import { isDownloadCode, LICENSE_SERVICE_URL, normalizeRegistrationKey } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import type { AppLicenseInfo } from '../../shared/ipcTypes.js';
import type { LicenseKeyStore } from './store.js';

/** The minimal fetch main needs; production passes Electron's net.fetch, as the Railway client does. */
export type LicenseFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const INACTIVE: AppLicenseInfo = { active: false, company: null, maxServers: 0, used: 0, validUntil: null };

export class LicenseManager {
  readonly #store: LicenseKeyStore;
  readonly #fetch: LicenseFetch;
  readonly #url: string;
  readonly #onDownloadCode: (code: string) => void;
  #cache: AppLicenseInfo | null = null;

  constructor(deps: { store: LicenseKeyStore; fetch: LicenseFetch; serviceUrl?: string; onDownloadCode?: (code: string) => void }) {
    this.#store = deps.store;
    this.#fetch = deps.fetch;
    this.#url = `${(deps.serviceUrl ?? LICENSE_SERVICE_URL).replace(/\/+$/, '')}/v1/key-info`;
    // Arms the update channel from the company download code the service returns (never shown to the renderer).
    this.#onDownloadCode = deps.onDownloadCode ?? (() => undefined);
  }

  /** The current license state; checks the stored key once (lazily) when it has not been checked yet. */
  async info(): Promise<AppLicenseInfo> {
    if (this.#cache) return this.#cache;
    const key = this.#store.read();
    if (!key) return INACTIVE;
    try {
      this.#cache = await this.#check(key);
      return this.#cache;
    } catch {
      // A lapse may be temporary (service down): keep the key, report inactive until it checks out again.
      return INACTIVE;
    }
  }

  /**
   * Synchronous: whether this install holds a registration key — i.e. the owner entered one here (a key is
   * stored), as opposed to a member who only cross-graded and never entered a key. The create-time image choice
   * reads this to pick a private-image server (the key holder) vs a normal one. It does NOT depend on a live
   * re-check: a flaky key-info call at launch must not silently turn the key holder into "normal". The key's
   * validity is enforced server-side when a server activates it, so a stored key is enough here. clear() flips
   * this back to false.
   */
  holdsKey(): boolean {
    try {
      return this.#store.read() !== null;
    } catch {
      return false;
    }
  }

  /** Enters a key: validates it first, and keeps it only when valid. Answers the new license state. */
  async activate(rawKey: string): Promise<AppLicenseInfo> {
    const key = normalizeRegistrationKey(rawKey);
    if (!key) throw new AppError('KEY_INVALID', 'not a registration key');
    if (!this.#store.canEncrypt()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const info = await this.#check(key);
    this.#store.save(key);
    this.#cache = info;
    return info;
  }

  /** Removes the key: the client goes back to normal (servers already created keep running). */
  clear(): AppLicenseInfo {
    this.#store.clear();
    this.#cache = null;
    return INACTIVE;
  }

  async #check(key: string): Promise<AppLicenseInfo> {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await this.#fetch(this.#url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    } catch {
      throw new AppError('KEY_UNREACHABLE');
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200) {
      if (!body || typeof body.maxServers !== 'number') throw new AppError('KEY_UNREACHABLE');
      // The company download code arms the update channel so the app switches to the paid edition. It is a
      // secret: it never goes into AppLicenseInfo (which the renderer reads), only to the main-side callback.
      if (isDownloadCode(body.downloadCode)) this.#onDownloadCode(body.downloadCode);
      return {
        active: true,
        company: typeof body.company === 'string' ? body.company : null,
        maxServers: body.maxServers,
        used: typeof body.used === 'number' ? body.used : 0,
        validUntil: typeof body.validUntil === 'number' ? body.validUntil : null,
      };
    }
    const code = typeof body?.code === 'string' ? body.code : '';
    if (code === 'revoked') throw new AppError('KEY_REVOKED');
    if (code === 'expired') throw new AppError('KEY_EXPIRED');
    if (code === 'rate_limited') throw new AppError('KEY_UNREACHABLE');
    throw new AppError('KEY_INVALID');
  }
}

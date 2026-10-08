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

const REGISTRY_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REGISTRY_TOKEN = /^[\x21-\x7e]{1,512}$/;

/** An image-pull credential the service may hand down with a valid key; null when it did not, or it is malformed. */
function plainRegistryCredential(value: unknown): { username: string; token: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { username, token } = value as { username?: unknown; token?: unknown };
  if (typeof username !== 'string' || typeof token !== 'string') return null;
  if (!REGISTRY_USER.test(username) || !REGISTRY_TOKEN.test(token)) return null;
  return { username, token };
}

export class LicenseManager {
  readonly #store: LicenseKeyStore;
  readonly #fetch: LicenseFetch;
  readonly #url: string;
  readonly #onDownloadCode: (code: string) => void;
  #cache: AppLicenseInfo | null = null;
  /** The company's enabled-agent keys, as the service's last key-info reported them (data, not literals). */
  #roster: string[] = [];
  /** An image-pull credential the service handed down with the key (main-only); null until one does. */
  #registry: { username: string; token: string } | null = null;

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

  /**
   * Fresh check before creating a private-image server: does the key still have room (used < maxServers)?
   * Re-reads the service so the count is current. Fail-open — answers true when there is no key or the service
   * cannot be reached, because the server enforces the real limit when it activates the key.
   */
  async serversAvailable(): Promise<boolean> {
    const key = this.#store.read();
    if (!key) return true;
    try {
      const info = await this.#check(key);
      this.#cache = info;
      return info.used < info.maxServers;
    } catch {
      return true;
    }
  }

  /**
   * The company's enabled agents from the last key-info check (empty until one runs, or on an older service).
   * Main-only; the paid build's provisioner reads it to decide which agents to put on a managed server.
   */
  agents(): string[] {
    return [...this.#roster];
  }

  /**
   * The image-pull credential the service handed down with the key (empty until a check runs, or on an older
   * service). Main-only; the paid build's provisioner uses it so the owner never pastes one per server.
   */
  registryCredential(): { username: string; token: string } | null {
    return this.#registry ? { ...this.#registry } : null;
  }

  /**
   * Re-checks the key now and refreshes the cached state — including the enabled agents and the pull credential
   * the service delivers. The provisioner calls this each cycle so an agent or a credential the panel started
   * serving after the app's first check is picked up on its own, without the owner restarting the app. Silent on
   * failure: the service may be unreachable this moment; the next cycle tries again and the old state stands.
   */
  async refresh(): Promise<void> {
    const key = this.#store.read();
    if (!key) return;
    try {
      this.#cache = await this.#check(key);
    } catch {
      // keep what we have; the next cycle tries again
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
    this.#roster = [];
    this.#registry = null;
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
      // The company's enabled agents (advisory): kept main-only, read by the provisioner. Names are data from
      // the service, never literals here. An older service sends none → empty (the paid build still has its base agent).
      this.#roster = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= 32) : [];
      // The pull credential travels the same way (secret, main-only): the provisioner uses it to fetch the
      // private agent image, so the owner sets one token on the service instead of pasting it per server.
      this.#registry = plainRegistryCredential(body.registry);
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

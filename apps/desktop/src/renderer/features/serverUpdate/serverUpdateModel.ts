// The owner's notice (spec 2026-10-01 §5): connected to a server I own that runs an older version
// than the app, a band at the top of the chat. Railway servers this app created update by
// themselves (main/railway/serverUpdates.ts); any other server shows how to update it.
// Members who are not the owner never see anything.
import { SITE_URL, compareReleaseVersions, isReleaseVersion } from '@ghostlink/shared';
import type { Locale } from '../../../shared/ipcTypes.js';
import type { ManagedServerUpdate } from '../../../shared/serverUpdateTypes.js';

export type OwnerUpdateNotice =
  /**
   * A Railway server this app created: it updates when the call empties ("Atualizar agora" skips the wait).
   * `addingAgent` is the paid build putting a company agent on the server — a progress band like the update's,
   * with `agent` naming the one going in; it shows on any version, even a server already current.
   */
  | { kind: 'managed'; version: string; target: string; state: 'waiting' | 'updating' | 'failed' | 'railwayDisconnected' | 'addingAgent'; agent?: string }
  /** Any other server (VPS, own Docker, Railway made by hand): "veja como". */
  | { kind: 'manual'; version: string; target: string };

export interface OwnerNoticeInput {
  /** I am the connected server's owner (the live text store, so a transfer hides it at once). */
  isOwner: boolean;
  /** The connected server's version, from its welcome. */
  serverVersion: string;
  /** app.info().version; null until known. */
  appVersion: string | null;
  /** serverUpdates.state(serverKeyId): null when this app did not create the server; undefined until main answered. */
  managed: ManagedServerUpdate | null | undefined;
}

/** What the band shows, or null when it does not show at all. */
export function ownerUpdateNotice(input: OwnerNoticeInput): OwnerUpdateNotice | null {
  const { isOwner, serverVersion, appVersion, managed } = input;
  if (!isOwner || appVersion === null || managed === undefined) return null;
  // Adding a company agent is independent of the version: show it even on a server already on the app's version
  // (the usual case — the agent goes onto a current server), so this comes before the version comparison below.
  if (managed !== null && managed.state === 'addingAgent') {
    return { kind: 'managed', version: serverVersion, target: appVersion, state: 'addingAgent', agent: managed.agent };
  }
  // Only release versions are compared: a development server or app never shows the band.
  if (!isReleaseVersion(serverVersion) || !isReleaseVersion(appVersion)) return null;
  if (compareReleaseVersions(serverVersion, appVersion) >= 0) return null;
  if (managed === null) return { kind: 'manual', version: serverVersion, target: appVersion };
  // Updated already: the reconnect brings the welcome with the new version in a moment.
  if (managed.state === 'current') return null;
  return { kind: 'managed', version: serverVersion, target: appVersion, state: managed.state === 'unknown' ? 'waiting' : managed.state };
}

/** A closed band stays closed for that server until what it says changes (this session only). */
export function noticeKey(serverKeyId: string, notice: OwnerUpdateNotice): string {
  const state = notice.kind === 'managed' ? notice.state : 'manual';
  const agent = notice.kind === 'managed' ? (notice.agent ?? '') : '';
  return [serverKeyId, notice.version, notice.target, state, agent].join('|');
}

/** "Veja como": updating a server the app does not manage (the site's page in the app's language). */
export function serverUpdateDocsUrl(locale: Locale): string {
  return locale === 'en' ? `${SITE_URL}en/host-on-vps#update` : `${SITE_URL}hospedar-em-vps#atualizar`;
}

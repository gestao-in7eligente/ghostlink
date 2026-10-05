// A signed update channel a server may advertise: a neutral, optional welcome field `updateChannel: { url }`.
// A server that advertises one tells its members "a build of this app is served, signed, at this URL"; the app
// reads it only as that, and never installs anything the pinned release key did not sign (updaterSignature.ts).
// The field is lenient on the wire: a value the app cannot use (not https, too long, not a URL) becomes absent,
// so a malformed advertisement is simply ignored instead of breaking the welcome.
import { z } from 'zod';

/** An advertised channel URL is bounded: a welcome carries only a short, plain URL. */
export const UPDATE_CHANNEL_MAX_URL = 2048;

/** True only for a parseable https URL no longer than the bound. Never throws. */
export function isUpdateChannelUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > UPDATE_CHANNEL_MAX_URL || !u.startsWith('https://')) return false;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

/** A channel a server advertises, once the app has accepted its URL. */
export interface UpdateChannel {
  url: string;
}

/**
 * The welcome's optional `updateChannel`. Lenient like the other client schemas: a bad url is dropped
 * (the field becomes absent) rather than failing the whole parse; only a non-object fails safeParse.
 */
export const updateChannelWelcomeSchema = z.object({
  url: z.string().refine(isUpdateChannelUrl).optional().catch(undefined),
});

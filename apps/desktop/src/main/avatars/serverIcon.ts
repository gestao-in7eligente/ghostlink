// The server icon as the connection announces it (spec 2026-10-01-icone-do-servidor): the
// welcome's `serverSettings.icon` on a server with the `serverIcon` flag, and every
// `server.updated`. The controller keeps the saved server's iconHash with it, so the rail
// shows the icon (from the disk cache) even for a server that is not open.
import { z } from 'zod';
import { FEATURE_SERVER_ICON, avatarHashSchema, serverInfoSchemaClient, type Envelope, type WelcomePayload } from '@ghostlink/shared';

const welcomeIconSchema = z.object({ serverSettings: z.object({ icon: avatarHashSchema.nullable().catch(null) }) });

/** The icon of a welcome's server: null without one, or from a server that has no icons. */
export function welcomeServerIcon(welcome: WelcomePayload): string | null {
  if (!welcome.features.includes(FEATURE_SERVER_ICON)) return null;
  const parsed = welcomeIconSchema.safeParse(welcome);
  return parsed.success ? parsed.data.serverSettings.icon : null;
}

/** The icon a `server.updated` carries (null: initials), or undefined for any other event or one that does not parse. */
export function updatedServerIcon(event: Envelope): string | null | undefined {
  if (event.t !== 'server.updated') return undefined;
  const parsed = serverInfoSchemaClient.safeParse(event.d);
  return parsed.success ? parsed.data.icon : undefined;
}

import type { ModuleContext, ServerModule } from '../modules.js';

/**
 * What voice needs from the Text module (release plan "Voice → Text access"). The
 * Text module owns channels, roles and membership; voice never reads their tables.
 */
export interface VoiceAccess {
  /** null when the channel does not exist. */
  channel(channelId: string): { type: 'text' | 'voice'; userLimit: number } | null;
  /** Effective bits in the channel, private-channel rules included; 0 when not visible. */
  permissions(userId: string, channelId: string): number;
  isOwner(userId: string): boolean;
  /** Highest role position (hierarchy checks in voice.moderate). */
  topPosition(userId: string): number;
}

/** Why a member left: the Text module's kick, ban and server.leave. */
export type MembershipRemovedReason = 'kicked' | 'banned' | 'left';

/** The Text module's in-process signals: `on(name, listener)` returns an unsubscribe. */
export interface TextEventsSeam {
  on(event: string, listener: (payload: never) => void): () => void;
}

/**
 * Optional members of the `text` module that voice uses when present:
 * - `voiceAccess` (object) or `getVoiceAccess()` (method): the VoiceAccess implementation;
 * - `onMembershipRemoved(listener)`: called after a kick, ban or leave, so voice drops the
 *   user at once (kick and ban already end the session through sessions.closeUser());
 * - `onPermissionsChanged(listener)`: called after any role, member-role or channel change
 *   that may change someone's effective bits, so voice re-applies LiveKit permissions now
 *   instead of at its next periodic sweep.
 * - `events.on(name, listener)` (the Text track's actual seam), with
 *   `membership.removed { userId, reason }`, `access.changed { userIds }`,
 *   `channel.deleted { channelId, type }` and `visibility.changed { userId, gained, lost }`.
 * Each subscription returns an unsubscribe function.
 */
export interface TextModuleVoiceSeams extends ServerModule {
  voiceAccess?: VoiceAccess;
  getVoiceAccess?(): VoiceAccess;
  onMembershipRemoved?(listener: (userId: string, reason: MembershipRemovedReason) => void): () => void;
  onPermissionsChanged?(listener: () => void): () => void;
  events?: TextEventsSeam;
}

/** The `text` module, or null when this server runs without one (then no channel exists). */
export function textModuleOf(ctx: ModuleContext): TextModuleVoiceSeams | null {
  try {
    return ctx.getModule<TextModuleVoiceSeams>('text');
  } catch {
    return null;
  }
}

/** Resolves VoiceAccess from the text module; a missing module means "no channels". */
export function voiceAccessOf(text: TextModuleVoiceSeams | null): VoiceAccess | null {
  if (!text) return null;
  if (text.voiceAccess) return text.voiceAccess;
  if (typeof text.getVoiceAccess === 'function') return text.getVoiceAccess();
  return null;
}

/** Stand-in when there is no Text module: nothing exists, nobody may do anything. */
export const NO_CHANNELS: VoiceAccess = {
  channel: () => null,
  permissions: () => 0,
  isOwner: () => false,
  topPosition: () => 0,
};

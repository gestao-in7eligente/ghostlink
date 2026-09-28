import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { VOICE_LIMITS, voiceIdentity, voiceRoomName, voiceSourcesFor, type VoiceSource } from '@ghostlink/shared';

/** The complete LiveKit permission block (spec §6), for tokens and every updateParticipant. */
export interface LivekitPermission {
  canSubscribe: true;
  canPublish: boolean;
  canPublishData: false;
  canPublishSources: TrackSource[];
  canUpdateMetadata: false;
  hidden: false;
}

const SOURCE: Readonly<Record<VoiceSource, TrackSource>> = {
  microphone: TrackSource.MICROPHONE,
  camera: TrackSource.CAMERA,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};

/**
 * `livekitPermission(user, channel, { serverMuted })` from spec §6, given the user's
 * effective bits in the channel. An EMPTY canPublishSources with canPublish: true would
 * mean "every source" to LiveKit, so canPublish is true only when the list is non-empty.
 * Always pass the whole block to updateParticipant: LiveKit overwrites every field.
 */
export function livekitPermission(bits: number, opts: { serverMuted: boolean }): LivekitPermission {
  const canPublishSources = voiceSourcesFor(bits, opts).map((s) => SOURCE[s]);
  return {
    canSubscribe: true,
    canPublish: canPublishSources.length > 0,
    canPublishData: false,
    canPublishSources,
    canUpdateMetadata: false,
    hidden: false,
  };
}

export interface JoinTokenInput {
  apiKey: string;
  apiSecret: string;
  userId: string;
  channelId: string;
  nickname: string;
  permission: LivekitPermission;
  /** Seconds; spec §8.2: 60 s, LiveKit refreshes it once connected. */
  ttlSeconds?: number;
}

/** Join token (spec §8.2): room ch_<channelId>, identity u_<userId>, name = nickname, metadata {"userId"}. */
export function createJoinToken(input: JoinTokenInput): Promise<string> {
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    identity: voiceIdentity(input.userId),
    name: input.nickname,
    metadata: JSON.stringify({ userId: input.userId }),
    ttl: input.ttlSeconds ?? VOICE_LIMITS.tokenTtlSeconds,
  });
  const p = input.permission;
  token.addGrant({
    roomJoin: true,
    room: voiceRoomName(input.channelId),
    canSubscribe: p.canSubscribe,
    canPublish: p.canPublish,
    canPublishData: p.canPublishData,
    canPublishSources: p.canPublishSources,
    canUpdateOwnMetadata: p.canUpdateMetadata,
    hidden: p.hidden,
  });
  return token.toJwt();
}

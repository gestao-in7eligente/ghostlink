// From directory.ts, not the feature index: the index pulls React components and DOM APIs.
import type { VoiceDirectory } from '../features/voice/directory.js';
import { sortedChannels } from '../stores/channels.js';
import { myPermissions } from '../stores/server.js';
import type { TextState } from '../stores/textState.js';

/**
 * The voice UI's directory built from the Text track's live stores, so nicknames,
 * channel names and permission changes reach the voice UI immediately (instead of
 * the welcome snapshot the Voice track falls back to).
 */
export function voiceDirectoryFromText(state: TextState): VoiceDirectory {
  return {
    displayName: (userId) => (Object.hasOwn(state.members.byId, userId) ? state.members.byId[userId]!.nickname : userId.slice(0, 8)),
    avatar: (userId) => (Object.hasOwn(state.members.byId, userId) ? state.members.byId[userId]!.avatar : null),
    channelName: (channelId) => (Object.hasOwn(state.channels.byId, channelId) ? state.channels.byId[channelId]!.name : null),
    voiceChannels: () => sortedChannels(state.channels.byId, 'voice').map(({ id, name }) => ({ id, name })),
    myPermissions: (channelId) => {
      const channel = Object.hasOwn(state.channels.byId, channelId) ? state.channels.byId[channelId]! : null;
      return myPermissions(state, channel ? { private: channel.private, allowedRoleIds: channel.allowedRoleIds } : undefined);
    },
  };
}

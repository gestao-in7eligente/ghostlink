import type { notifications as notificationsPt } from './notifications.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const notifications: Record<keyof typeof notificationsPt, string> = {
  'notifications.title': 'Notifications',
  'notifications.desktop': 'Show desktop notifications',
  'notifications.desktopHint': 'Messages, DMs and friend requests appear in the corner of the screen when GhostLink is not in focus.',
  'notifications.mode.all': 'All messages',
  'notifications.mode.mentions': 'Only @mentions',
  'notifications.mode.none': 'Nothing',
  'notifications.file': 'sent a file',
  'notifications.files': 'sent {count} files',
  'notifications.friendRequest.title': 'Friend request',
  'notifications.friendRequest.body': '{name} wants to be your friend.',
  'notifications.close': 'Close',
};

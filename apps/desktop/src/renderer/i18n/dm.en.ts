import type { dm as dmPt } from './dm.pt-BR.js';

// Typed against the pt-BR namespace: a missing or extra key fails the typecheck.
export const dm: Record<keyof typeof dmPt, string> = {
  'dm.open': 'Message',
  'dm.openWith': 'Message {name}',
  'dm.close': 'Close the conversation with {name}',
  'dm.unread': '{count} unread messages',
  'dm.region': 'Messages with {name}',
  'dm.placeholder': 'Message @{name}',
  'dm.start': 'This is the beginning of your conversation with {name}.',
  'dm.startHint': 'Messages travel straight between your computers and are end-to-end encrypted.',
  'dm.offline': '{name} is offline. The message arrives when you are both online.',
  'dm.notFriend': 'You are not friends anymore. The conversation is read-only.',
  'dm.sent': 'Sent',
  'dm.delivered': 'Delivered',
  'dm.typing': '{name} is typing…',
  'dm.loadingOlder': 'Loading earlier messages…',
  'dm.deleteTitle': 'Delete message?',
  'dm.deleteBody': 'The message disappears for both of you.',
  'dm.delete': 'Delete',
  'dm.deleted': 'Message deleted',
  'dm.tooLong': 'The message is over {max} characters.',
  'dm.replyUnknown': 'An earlier message',
};

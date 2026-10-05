// The small emoji picker (spec §11.1: reactions with a small picker). Every entry is
// a single RGI emoji, so the server accepts it as a reaction (tested).
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;

export const EMOJI = [
  '👍', '👎', '❤️', '😂', '🤣', '😊', '😍', '🥰',
  '😎', '🤩', '🥳', '😮', '😱', '😢', '😭', '😡',
  '🤔', '🙃', '😅', '😬', '😴', '🤯', '🥲', '😇',
  '🙏', '👏', '🙌', '💪', '👋', '🤝', '👀', '🫡',
  '🎉', '🔥', '✨', '⭐', '💯', '✅', '❌', '⚠️',
  '🚀', '🎮', '🎧', '🍕', '☕', '👻', '💀', '💜',
] as const;

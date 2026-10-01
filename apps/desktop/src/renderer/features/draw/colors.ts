// How a person's strokes look: their own color, chosen by their userId, and their name at the tip
// (spec 2026-10-01-lapis-na-tela §1). These are the only colors of the app outside
// styles/tokens.css: strokes sit on top of whatever is on the shared screen, so they are bright,
// saturated hues that read on dark and light content alike, all light enough for the dark label text.

/** The pencil palette, by name. */
export const PENCIL_PALETTE = {
  coral: '#ff6b6b',
  tangerine: '#ff9f43',
  sunflower: '#feca57',
  mint: '#1dd1a1',
  sky: '#48dbfb',
  azure: '#54a0ff',
  lavender: '#a29bfe',
  orchid: '#f78fe3',
} as const;

export const PENCIL_COLORS: readonly string[] = Object.values(PENCIL_PALETTE);

/** FNV-1a over the id: the same person gets the same color on every screen and in every app. */
export function pencilColor(userId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PENCIL_COLORS[hash % PENCIL_COLORS.length]!;
}

const LABEL_MAX = 24;

/** A name short enough for the label at a stroke's tip. */
export function labelText(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= LABEL_MAX ? chars.join('') : `${chars.slice(0, LABEL_MAX - 1).join('')}…`;
}

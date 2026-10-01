// The keyboard model of the Select primitive (primitives.tsx): which option the arrow keys
// and type-ahead land on. Pure, so it is tested without a DOM.

/** Options a page key jumps over (about what the list shows before it scrolls). */
export const SELECT_PAGE = 8;

/** The option an arrow, Home, End or Page key moves to from `current` (-1: none yet); null for other keys. */
export function selectMove(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : Math.min(current + 1, last);
    case 'ArrowUp':
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return Math.min(Math.max(current, 0) + SELECT_PAGE, last);
    case 'PageUp':
      return Math.max(current - SELECT_PAGE, 0);
    default:
      return null;
  }
}

/** Case- and accent-insensitive text for type-ahead ("ó" matches "o"). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Type-ahead: the option whose label starts with what was typed, searching after `current`
 * and wrapping around. Typing more letters refines the current match; one letter typed again
 * moves on to the next option with that letter. -1 when nothing matches.
 */
export function selectTypeahead(labels: readonly string[], typed: string, current: number): number {
  const query = foldText(typed);
  if (query === '' || labels.length === 0) return -1;
  const repeated = [...query].every((c) => c === query[0]);
  const needle = repeated ? query[0]! : query;
  // A longer query may still match the current option; a single (or repeated) letter moves on.
  const first = repeated ? current + 1 : Math.max(current, 0);
  for (let k = 0; k < labels.length; k++) {
    const i = (((first + k) % labels.length) + labels.length) % labels.length;
    if (foldText(labels[i]!).startsWith(needle)) return i;
  }
  return -1;
}

/** Whether a key press is a character to type (not a shortcut, not a named key). */
export function isTypeaheadKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

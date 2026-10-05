import type { Translate } from '../../i18n/index.js';

const SYMBOLS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const MODIFIERS: Readonly<Record<string, string>> = { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Win' };

/** How a push-to-talk key (a DOM KeyboardEvent.code) reads on the keyboard. */
export function keyLabel(code: string, t: Translate): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  if (code === 'Space') return t('voice.key.space');
  if (Object.hasOwn(SYMBOLS, code)) return SYMBOLS[code]!;
  const side = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(code);
  if (side) return t(side[2] === 'Left' ? 'voice.key.left' : 'voice.key.right', { key: MODIFIERS[side[1]!]! });
  return code;
}

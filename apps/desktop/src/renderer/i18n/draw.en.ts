// The pencil on shared screens (v0.2.3): same keys as draw.pt-BR.ts.
import type { draw as ptBR } from './draw.pt-BR.js';

export const draw: Record<keyof typeof ptBR, string> = {
  'draw.pencil': 'Draw on the screen',
  'draw.pencilStop': 'Stop drawing (Esc)',
  'draw.allow': 'Allow drawing',
  'draw.allowHint': 'Viewers can mark your screen. Strokes fade away on their own after 3 seconds.',
};

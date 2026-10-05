import type { owner as ptBR } from './owner.pt-BR.js';

// Owner namespace (English). Typed against pt-BR: a missing or extra key fails the typecheck.
export const owner: Record<keyof typeof ptBR, string> = {
  'join.owner.toggle': 'I own this server',
  'join.owner.label': 'Owner code',
  'join.owner.hint': 'It shows up in the server logs the first time it starts (or with {command}).',
};

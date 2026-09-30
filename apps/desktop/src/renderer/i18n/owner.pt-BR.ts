// Owner namespace: "Sou o dono deste servidor" in the Join flow (spec §3.3 "Dono").
// Spread into pt-BR.ts; owner.en.ts must have exactly the same keys.
// `{command}` is the CLI command, shown verbatim and never translated.
export const owner = {
  'join.owner.toggle': 'Sou o dono deste servidor',
  'join.owner.label': 'Código de dono',
  'join.owner.hint': 'Aparece nos logs do servidor na primeira vez que ele inicia (ou com {command}).',
} as const;

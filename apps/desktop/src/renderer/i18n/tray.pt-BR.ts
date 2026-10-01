// The tray icon and "Ao fechar, manter na bandeja" (v0.3.2): the ghost stays near the clock, as Discord's does.
// Spread into pt-BR.ts (main's tray reads it too); tray.en.ts must have exactly the same keys.
export const tray = {
  'tray.open': 'Abrir GhostLink',
  'tray.quit': 'Sair do GhostLink',
  'tray.notice': 'O GhostLink continua rodando na bandeja. Para sair, use o ícone perto do relógio.',

  'tray.settings.title': 'Janela',
  'tray.settings.closeToTray': 'Ao fechar, manter na bandeja',
  'tray.settings.closeToTrayHint':
    'O X esconde a janela e o GhostLink continua rodando perto do relógio, chamadas inclusive. Para sair de vez, use "Sair do GhostLink" no ícone.',
} as const;

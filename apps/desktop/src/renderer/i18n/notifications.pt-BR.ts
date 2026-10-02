// GhostLink's own notifications (v0.4.2, spec 2026-10-02-notificacoes-design.md): the cards in the
// corner of the screen, each server's mode and the setting. Spread into pt-BR.ts (main's notifier
// reads it too); notifications.en.ts must have exactly the same keys.
export const notifications = {
  'notifications.title': 'Notificações',
  'notifications.desktop': 'Mostrar notificações na área de trabalho',
  'notifications.desktopHint': 'Mensagens, DMs e pedidos de amizade aparecem no canto da tela quando o GhostLink não está em foco.',
  'notifications.mode.all': 'Todas as mensagens',
  'notifications.mode.mentions': 'Só @menções',
  'notifications.mode.none': 'Nada',
  'notifications.file': 'enviou um arquivo',
  'notifications.files': 'enviou {count} arquivos',
  'notifications.friendRequest.title': 'Pedido de amizade',
  'notifications.friendRequest.body': '{name} quer ser seu amigo.',
  'notifications.close': 'Fechar',
} as const;

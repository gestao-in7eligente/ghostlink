// Leaving and deleting a server (v0.2.4, spec 2026-10-01-sair-e-excluir-servidor-design.md).
// Spread into pt-BR.ts; serverDelete.en.ts must have exactly the same keys.
export const serverDelete = {
  // The menus: members leave, the owner deletes (nobody "removes from the list" any more).
  'serverExit.delete': 'Excluir servidor',
  'serverExit.menu': 'Opções de {name}',

  // The delete modal (spec §3).
  'serverDelete.title': 'Excluir {name}?',
  'serverDelete.body': 'O servidor sai do ar agora para todos. Ele é apagado de vez em 48 h — mensagens, canais, cargos e arquivos. Até lá, você pode restaurá-lo.',
  'serverDelete.nameLabel': 'Digite o nome do servidor para confirmar',
  'serverDelete.confirm': 'Excluir servidor',

  // The owner's band while the server waits for its deadline.
  'serverDelete.banner': '{name} está fora do ar e será excluído em {time}.',
  'serverDelete.bannerLabel': 'Servidor sendo excluído',
  'serverDelete.restore': 'Restaurar servidor',
  'serverDelete.inHours': '{count} h',
  'serverDelete.inMinutes': '{count} min',
  'serverDelete.inMoments': 'instantes',

  // What members see (spec §3 "App dos membros").
  'serverDelete.lostTitle': 'Servidor desligado',
  'serverDelete.deletedTitle': 'Servidor excluído',
  'serverDelete.deleting': '{name} foi desligado pelo dono e será excluído em {date}.',
  'serverDelete.deletingSoon': '{name} foi desligado pelo dono e será excluído em breve.',
  'serverDelete.deleted': '{name} foi excluído pelo dono.',

  // Settings → Visão geral.
  'serverDelete.dangerZone': 'Zona de perigo',
  'serverDelete.dangerHint': 'Tira o servidor do ar para todos agora e o apaga de vez em 48 h. Até lá, dá para restaurar.',

  // "Sair do servidor" on a server that is not open: the app connects first.
  'serverExit.checking': 'Conectando a {name}…',
  'serverExit.unreachableTitle': 'Não foi possível falar com o servidor',
  'serverExit.unreachableBody': '{name} não respondeu: {reason} Você pode tirá-lo só da sua lista.',
  'serverExit.removeOnly': 'Tirar só da minha lista',
  'serverExit.ownerCannot': 'Você é o dono de {name}, e o dono não sai do servidor. Este servidor ainda não pode ser excluído pelo app: ele precisa ser atualizado primeiro.',
  'serverExit.ownerDeleting': '{name} já está fora do ar e será excluído em {time}. Abra o servidor para restaurá-lo.',
  'serverExit.close': 'Fechar',
} as const;

/** Keys whose English text is the same on purpose (units). */
export const SERVER_DELETE_SAME_IN_BOTH = ['serverDelete.inHours', 'serverDelete.inMinutes'] as const;

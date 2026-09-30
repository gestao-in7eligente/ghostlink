// Friends (v0.3): the Home screen's friends page. Spread into pt-BR.ts;
// friends.en.ts must have exactly the same keys.
export const friends = {
  'friends.title': 'Amigos',
  'friends.tabs': 'Mostrar',
  'friends.tab.online': 'Online',
  'friends.tab.all': 'Todos',
  'friends.tab.pending': 'Pendentes',
  'friends.tab.blocked': 'Bloqueados',
  'friends.add': 'Adicionar amigo',
  'friends.search': 'Buscar',
  'friends.searchOpen': 'Encontre ou comece uma conversa',
  'friends.count.online': 'Online — {count}',
  'friends.count.all': 'Todos os amigos — {count}',
  'friends.count.pending': 'Pendentes — {count}',
  'friends.count.blocked': 'Bloqueados — {count}',
  'friends.pendingBadge': '{count} pedidos de amizade pendentes',

  'friends.status.online': 'Online',
  'friends.status.offline': 'Offline',
  'friends.status.pendingIn': 'Quer ser seu amigo · código {code}',
  'friends.status.pendingOut': 'Pedido enviado · código {code}',
  'friends.status.blocked': 'Bloqueado · código {code}',
  'friends.unnamed': 'Pessoa ainda sem nome',

  'friends.action.accept': 'Aceitar',
  'friends.action.decline': 'Recusar',
  'friends.action.cancel': 'Cancelar pedido',
  'friends.action.block': 'Bloquear',
  'friends.action.unblock': 'Desbloquear',
  'friends.action.remove': 'Desfazer amizade',
  'friends.action.rename': 'Mudar apelido',
  'friends.action.more': 'Mais opções de {name}',

  'friends.add.lead': 'Cole o código de amigo da pessoa. Ela recebe o pedido quando vocês dois estiverem online.',
  'friends.add.label': 'Código de amigo',
  'friends.add.placeholder': 'GLF1-XXXX-XXXX-…',
  'friends.add.submit': 'Enviar pedido de amizade',
  'friends.add.sending': 'Enviando…',
  'friends.add.sent': 'Pedido enviado. Ele fica em Pendentes até a pessoa aceitar.',

  'friends.code.title': 'Seu código de amigo',
  'friends.code.hint': 'Mande este código para quem você quer ter como amigo. Quem tem o código consegue te enviar pedidos e, ao conectar, vê o seu IP.',
  'friends.code.copy': 'Copiar código',
  'friends.code.copied': 'Copiado',
  'friends.code.new': 'Gerar código novo',
  'friends.code.newTitle': 'Gerar um código novo?',
  'friends.code.newBody': 'O código atual para de funcionar para pedidos novos. Seus amigos continuam na lista.',
  'friends.code.newConfirm': 'Gerar código',
  'friends.code.inbox': 'Aceitar pedidos por código',

  'friends.empty.all': 'Você ainda não tem amigos. Clique em Adicionar amigo para colar o código de alguém ou copiar o seu.',
  'friends.empty.online': 'Nenhum amigo online agora.',
  'friends.empty.pending': 'Nenhum pedido pendente.',
  'friends.empty.blocked': 'Você não bloqueou ninguém.',
  'friends.empty.search': 'Ninguém encontrado.',

  'friends.off.title': 'Você está invisível para amigos',
  'friends.off.text': 'Com isso desligado, o GhostLink não recebe pedidos nem mostra quem está online.',
  'friends.off.turnOn': 'Ficar disponível para amigos',
  'friends.failed.title': 'A rede de amigos não iniciou',
  'friends.failed.retry': 'Tentar de novo',
  'friends.loading': 'Carregando amigos…',

  'friends.rename.title': 'Apelido de {name}',
  'friends.rename.label': 'Apelido (só você vê)',
  'friends.rename.save': 'Salvar',
  'friends.rename.clear': 'Tirar apelido',
  'friends.remove.title': 'Desfazer amizade com {name}?',
  'friends.remove.body': 'Vocês deixam de aparecer um para o outro. Dá para adicionar de novo depois.',
  'friends.block.title': 'Bloquear {name}?',
  'friends.block.body': 'A amizade acaba e os pedidos dessa pessoa passam a ser ignorados.',

  'friends.dm.title': 'Mensagens diretas',
  'friends.dm.empty': 'Suas conversas com amigos aparecem aqui.',
  'friends.panel.online': 'Online para amigos',
  'friends.panel.invisible': 'Invisível para amigos',

  'rail.server.menu': 'Opções de {name}',

  'errors.FRIEND_CODE_INVALID': 'Esse código de amigo não é válido. Confira se copiou o código inteiro.',
  'errors.FRIEND_SELF': 'Esse é o seu próprio código.',
  'errors.FRIEND_LIMIT': 'Você chegou ao limite de amigos ou de pedidos pendentes.',
  'errors.P2P_UNAVAILABLE': 'A rede de amigos não está disponível agora.',
} as const;

/** Texts that read the same in both languages on purpose (the i18n test skips them). */
export const FRIENDS_SAME_IN_BOTH = ['friends.tab.online', 'friends.count.online', 'friends.status.online', 'friends.status.offline', 'friends.add.placeholder'] as const;

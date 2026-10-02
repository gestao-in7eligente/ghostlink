// Bots (v0.4.0, spec 2026-10-02-bots-design.md §3). Spread into pt-BR.ts; bots.en.ts must have
// exactly the same keys.
export const bots = {
  // The sidebar's section, above "CANAIS DE TEXTO".
  'bots.section': 'Bots',
  'bots.add': 'Adicionar bot',
  'bots.rowLabel': '{name}, bot, {status}',
  'bots.menu': 'Opções de {name}',
  'bots.tag': 'BOT',

  // "Adicionar bot": name and photo.
  'bots.create.title': 'Adicionar bot',
  'bots.create.name': 'Nome do bot',
  'bots.create.nameHint': 'Aparece nas mensagens e na lista de membros, com a etiqueta BOT.',
  'bots.create.photo': 'Foto do bot',
  'bots.create.photoChoose': 'Escolher foto',
  'bots.create.photoChange': 'Trocar foto',
  'bots.create.photoRemove': 'Remover',
  'bots.create.photoHint': 'Opcional. O bot também pode enviar a própria foto quando se conectar.',
  'bots.create.submit': 'Criar bot',
  'bots.create.photoFailed': 'O bot foi criado, mas a foto não foi enviada: {reason}',

  // The one-time connection code.
  'bots.code.title': 'Código de conexão de {name}',
  'bots.code.body': 'Cole este código na variável de ambiente GHOSTLINK_BOT do seu bot. Com ele, o bot entra neste servidor como {name}.',
  'bots.code.label': 'Código de conexão',
  'bots.code.warning': 'Guarde agora: ele não aparece de novo.',
  'bots.code.copy': 'Copiar',
  'bots.code.copied': 'Copiado',
  'bots.code.guide': 'Como conectar o bot (guia)',
  'bots.code.done': 'Pronto',

  // The bot's menu (right click / ⋮).
  'bots.regenerate': 'Gerar novo código',
  'bots.regenerate.title': 'Gerar novo código para {name}?',
  'bots.regenerate.body': 'O código atual deixa de funcionar e o bot é desconectado agora. Ele só volta com o código novo.',
  'bots.delete': 'Excluir bot',
  'bots.delete.title': 'Excluir {name}?',
  'bots.delete.body': 'O bot sai do servidor e o código dele deixa de funcionar. As mensagens dele ficam, como de um bot excluído.',
  'bots.deletedBot': 'bot excluído',

  // The "/" in the composer.
  'slash.suggestions': 'Comandos',
  'slash.by': 'de {bot}',
  'slash.command': 'Comando /{command} de {bot}',
  'slash.cancel': 'Cancelar o comando',
  'slash.optional': 'Opções',
  'slash.addOption': 'Adicionar a opção {name}',
  'slash.removeOption': 'Tirar a opção {name}',
  'slash.optionLabel': '{name}: {description}',
  'slash.yes': 'Sim',
  'slash.no': 'Não',
  'slash.pickUser': 'Escolher pessoa',
  'slash.pickChannel': 'Escolher canal',
  'slash.choose': 'Escolher',
  'slash.hint': 'Enter envia · Tab passa para a próxima opção · Esc cancela',
  'slash.error.required': 'Preencha {name}.',
  'slash.error.integer': '{name} precisa ser um número inteiro.',
  'slash.error.number': '{name} precisa ser um número.',
  'slash.error.choice': 'Escolha uma das opções de {name}.',
  'slash.error.tooLong': '{name} está longo demais.',
  'slash.failed': 'O comando não foi enviado: {reason}',

  // Interaction messages.
  'slash.used': '{name} usou {command}',
  'slash.ephemeral': 'Só você pode ver isto',
  'slash.dismiss': 'Dispensar',
  'slash.thinking': '{bot} está pensando…',
  'slash.noResponse': 'O bot não respondeu',

  // Error codes of bots (shared/errors.ts).
  'errors.BAD_BOT_TOKEN': 'Código de conexão inválido ou substituído.',
  'errors.BOT_OFFLINE': 'O bot está offline agora.',
} as const;

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const BOTS_SAME_IN_BOTH = ['bots.section', 'bots.tag', 'bots.rowLabel', 'slash.optionLabel'] as const;

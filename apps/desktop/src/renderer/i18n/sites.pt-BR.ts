// The Sites category (v0.7.0, spec 2026-10-03-aba-api-e-sites-design.md §2). Spread into pt-BR.ts;
// sites.en.ts must have exactly the same keys.
export const sites = {
  'sites.section': 'Sites',
  'sites.add': 'Cadastrar site',
  'sites.empty': 'Cadastre os sites da empresa: o Hermes posta no canal de cada um o que fizer nele.',
  'sites.createTitle': 'Cadastrar site',
  'sites.editTitle': 'Editar {name}',
  'sites.name': 'Nome',
  'sites.nameExample': 'Profeta Cristão ES',
  'sites.domain': 'Endereço',
  'sites.domainExample': 'es.profetacristao.com',
  'sites.domainHint': 'Só o domínio, sem caminho e sem senha.',
  'sites.channel': 'Canal',
  'sites.newChannel': 'Criar canal novo',
  'sites.newChannelHint': 'Um canal de texto com o nome do endereço.',
  'sites.moveHint': 'O canal vai para Sites com todo o histórico.',
  'sites.create': 'Cadastrar',
  'sites.save': 'Salvar',
  'sites.likely': 'Canais com nome de site: {n}',
  'sites.registerLikely': 'Cadastrar como sites',
  'sites.partial': '{done} de {total} cadastrados; o resto parou por um erro.',
  'sites.edit': 'Editar site',
  'sites.remove': 'Remover site',
  'sites.removeTitle': 'Remover {name} dos sites?',
  'sites.removeBody': 'O canal #{channel} continua, com todo o histórico, e volta para Canais de texto.',
  'sites.problem.name': 'Dê um nome ao site.',
  'sites.problem.domain': 'Use só o domínio, como es.profetacristao.com.',
  'sites.problem.limit': 'O limite é de 50 sites.',
};

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const SITES_SAME_IN_BOTH = ['sites.section', 'sites.nameExample', 'sites.domainExample'] as const;

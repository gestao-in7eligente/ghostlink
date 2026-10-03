// Enterprise and the company Hermes (v0.6.0, spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md).
// Spread into pt-BR.ts; enterprise.en.ts must have exactly the same keys.
export const enterprise = {
  'errors.ENTERPRISE_REQUIRED': 'Isso só funciona num servidor Enterprise.',
  'errors.LICENSE_INVALID': 'Essa licença não vale para este servidor.',
  'errors.LICENSE_EXPIRED': 'Essa licença já venceu.',
  'enterprise.badge': 'Enterprise',
  'enterprise.badgeTitle': 'Servidor Enterprise',
  'serverSettings.tab.enterprise': 'Enterprise',
  'enterprise.tab.intro': 'Servidores Enterprise têm o Hermes da empresa e não têm o Ghost DJ.',
  'enterprise.tab.edition.enterprise': 'Este servidor é Enterprise.',
  'enterprise.tab.edition.normal': 'Este servidor é normal.',
  'enterprise.tab.none': 'Nenhuma licença colada.',
  'enterprise.tab.state.valid': 'Licença de {company}, válida até {date}.',
  'enterprise.tab.state.expiring': 'Licença de {company}: vence em {date}.',
  'enterprise.tab.state.grace': 'Licença de {company}: venceu em {date}. O servidor volta a ser normal em {grace}.',
  'enterprise.tab.state.expired': 'Licença de {company}: venceu em {date}. O servidor voltou a ser normal.',
  'enterprise.tab.state.wrong-server': 'A licença guardada é de outro servidor.',
  'enterprise.tab.state.invalid': 'A licença guardada não pôde ser conferida.',
  'enterprise.tab.identity': 'Identidade do servidor',
  'enterprise.tab.identityHint': 'A licença é feita para esta identidade. Envie-a a quem emite a licença.',
  'enterprise.tab.paste': 'Colar licença',
  'enterprise.tab.pasteHint': 'Uma licença nova substitui a atual na hora, sem reiniciar o servidor.',
  'enterprise.tab.save': 'Salvar licença',
  'enterprise.tab.saved': 'Licença salva.',
  'enterprise.banner.expiring': 'A licença Enterprise deste servidor vence em {date}.',
  'enterprise.banner.grace': 'A licença Enterprise venceu. O servidor volta a ser normal em {date}.',
  'enterprise.bannerLabel': 'Aviso da licença Enterprise',
};

/** Keys whose English text is the same on purpose (i18n.test.ts). */
export const ENTERPRISE_SAME_IN_BOTH = ['enterprise.badge', 'serverSettings.tab.enterprise'] as const;

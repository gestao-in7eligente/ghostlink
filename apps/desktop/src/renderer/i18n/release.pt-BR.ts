// Namespace `updates` (Release track): update banner and the Updates settings section.
export const releasePtBR = {
  'updates.banner.label': 'Atualização do GhostLink',
  'updates.banner.downloaded': 'Nova versão {version} baixada',
  'updates.banner.downloadedHint': 'Ela já foi conferida com a assinatura oficial de release.',
  'updates.banner.restart': 'Reiniciar para atualizar',
  'updates.banner.later': 'Depois',
  'updates.banner.rejected': 'A versão {version} não passou na verificação de assinatura e não foi instalada.',
  'updates.banner.rejectedHint': 'Baixe o GhostLink só pelo site oficial ou pela página de releases no GitHub.',
  'updates.banner.dismiss': 'Fechar aviso',

  'updates.settings.title': 'Atualizações',
  'updates.settings.autoCheck': 'Procurar atualizações automaticamente',
  'updates.settings.autoCheckHint':
    'Ao abrir e a cada 6 horas, o app consulta as releases do GhostLink no GitHub. É o único contato do app com terceiros. Uma atualização só é instalada se tiver a assinatura da chave oficial de release.',
  'updates.settings.version': 'Versão instalada: {version}',
  'updates.settings.unsupported': 'A atualização automática só funciona no app instalado no Windows. As versões novas ficam no site do GhostLink.',

  'updates.status.idle': 'Nenhuma atualização pendente.',
  'updates.status.disabled': 'A procura automática está desligada.',
  'updates.status.checking': 'Procurando atualizações…',
  'updates.status.upToDate': 'Você está na versão mais recente.',
  'updates.status.checkFailed': 'Não foi possível procurar atualizações agora. Confira a conexão e tente de novo.',
  'updates.status.downloading': 'Baixando a {version}… {percent}%',
  'updates.status.downloaded': 'A {version} está pronta para instalar.',

  // The Updates page (v0.2.3): check by hand, install from there, and what is new.
  'updates.page.checkNow': 'Procurar atualizações',
  'updates.page.checking': 'Procurando…',
  'updates.page.checkedToday': 'Última verificação: hoje, às {time}.',
  'updates.page.checkedOn': 'Última verificação: {date}, às {time}.',
  'updates.page.progress': 'Download da {version}',
  'updates.page.downloadingHint': 'Depois de baixada, ela é conferida com a assinatura oficial de release antes de poder ser instalada.',
  'updates.page.downloadedHint': 'Já conferida com a assinatura oficial de release. O app fecha, instala a versão nova e abre de novo sozinho.',
  'updates.page.restart': 'Atualizar e reiniciar',
  'updates.page.newNotes': 'O que muda na {version}',
  'updates.page.installedNotes': 'O que mudou na sua versão ({version})',
  'updates.page.notesLoading': 'Carregando as novidades…',
  'updates.page.notesUnavailable': 'Não foi possível carregar as novidades da {version}.',
  'updates.page.notesMissing': 'Não há notas para a {version}.',
  'updates.page.notesOnGitHub': 'Ver no GitHub',

  // The splash when the app opens (main/updateSplash.ts reads these, like the tray reads host.tray.*).
  'updates.splash.checking': 'Procurando atualizações…',
  'updates.splash.downloading': 'Baixando atualização… {percent}%',
  'updates.splash.installing': 'Instalando…',
  'updates.splash.skip': 'Abrir sem atualizar',
} as const;

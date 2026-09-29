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
  'updates.status.downloading': 'Baixando a versão {version}… {percent}%',
  'updates.status.downloaded': 'A versão {version} está pronta. Reinicie para atualizar.',
} as const;

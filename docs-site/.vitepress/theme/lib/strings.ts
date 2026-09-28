// Texts of the site's Vue components. Pages themselves are written per language in Markdown.

const pt = {
  beta: 'GhostLink está em beta: a versão 0.1 é só para Windows.',
  download: {
    button: 'Baixar para Windows',
    requirements: 'Windows 10 ou 11, 64 bits',
    checking: 'Procurando a versão mais recente…',
    version: 'Versão {version}',
    size: '{size} MB',
    failed: 'Não deu para consultar a versão mais recente agora. O botão abre a página da última release, onde fica o instalador.',
    notWindows:
      'A versão 0.1 só tem instalador para Windows. A versão para macOS vem depois; o servidor roda em Linux (veja Hospedar numa VPS).',
  },
  invite: {
    reading: 'Abrindo o convite…',
    invitedTo: 'Você foi convidado para',
    unnamed: 'um servidor GhostLink',
    opening: 'Abrindo o GhostLink… Se o navegador perguntar, permita abrir o app.',
    opened: 'O GhostLink deve ter aberto com o convite. Pode fechar esta página.',
    manual: 'Clique em Abrir no GhostLink para entrar pelo app.',
    openApp: 'Abrir no GhostLink',
    notOpened: 'Não abriu?',
    noAppTitle: 'Ainda não tem o GhostLink?',
    step1: 'Baixe e instale o app.',
    step2: 'Abra o GhostLink, escolha Entrar num servidor e cole este código:',
    copy: 'Copiar código',
    copied: 'Copiado',
    copyFailed: 'Selecione o código e copie com Ctrl+C.',
    codeLabel: 'Código do convite',
    addresses: 'Endereços do servidor',
    privacy:
      'O convite fica só no seu navegador: a parte do link depois do # nunca é enviada a nenhum servidor, nem a este site.',
    invalidTitle: 'Este link de convite não funciona',
    invalidBody:
      'Ele está incompleto ou foi alterado. Peça um convite novo a quem convidou você e, se ele vier cortado, copie o link inteiro.',
    guide: 'Primeiros passos',
    guideLink: '/primeiros-passos',
  },
};

type Strings = typeof pt;
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

const en: Shape<Strings> = {
  beta: 'GhostLink is in beta: version 0.1 is Windows-only.',
  download: {
    button: 'Download for Windows',
    requirements: 'Windows 10 or 11, 64-bit',
    checking: 'Looking up the latest version…',
    version: 'Version {version}',
    size: '{size} MB',
    failed: 'Could not look up the latest version right now. The button opens the latest release page, where the installer is.',
    notWindows:
      'Version 0.1 only has a Windows installer. The macOS app comes later; the server runs on Linux (see Host on a VPS).',
  },
  invite: {
    reading: 'Opening the invite…',
    invitedTo: 'You were invited to',
    unnamed: 'a GhostLink server',
    opening: 'Opening GhostLink… If your browser asks, allow it to open the app.',
    opened: 'GhostLink should have opened with the invite. You can close this page.',
    manual: 'Click Open in GhostLink to join from the app.',
    openApp: 'Open in GhostLink',
    notOpened: 'Did not open?',
    noAppTitle: 'Don’t have GhostLink yet?',
    step1: 'Download and install the app.',
    step2: 'Open GhostLink, choose Join a server and paste this code:',
    copy: 'Copy code',
    copied: 'Copied',
    copyFailed: 'Select the code and copy it with Ctrl+C.',
    codeLabel: 'Invite code',
    addresses: 'Server addresses',
    privacy: 'The invite stays in your browser: the part of the link after the # is never sent to any server, not even this site.',
    invalidTitle: 'This invite link does not work',
    invalidBody:
      'It is incomplete or was changed. Ask whoever invited you for a new invite and, if it arrives cut off, copy the whole link.',
    guide: 'Getting started',
    guideLink: '/en/getting-started',
  },
};

export type SiteLang = 'pt' | 'en';

/** `pt-BR` (the root locale) and any other Portuguese tag get Portuguese; everything else English. */
export function siteLangOf(tag: string | undefined | null): SiteLang {
  return typeof tag === 'string' && /^pt\b/i.test(tag) ? 'pt' : 'en';
}

export function stringsFor(tag: string | undefined | null): Shape<Strings> {
  return siteLangOf(tag) === 'pt' ? pt : en;
}

/** Replaces `{name}` placeholders. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

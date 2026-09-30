// GhostLink site (spec §16): VitePress, pt-BR at the root and English under /en/, served by GitHub
// Pages at https://gestao-in7eligente.github.io/ghostlink/. No trackers, no external fonts or
// scripts: the only third-party call is the GitHub API behind the download buttons.
import { defineConfig } from 'vitepress';
import type { DefaultTheme } from 'vitepress';

export const BASE = '/ghostlink/';
export const REPO_URL = 'https://github.com/gestao-in7eligente/ghostlink';

function sidebarPt(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Começar',
      items: [
        { text: 'Baixar', link: '/download' },
        { text: 'Primeiros passos', link: '/primeiros-passos' },
      ],
    },
    {
      text: 'Hospedar',
      items: [
        { text: 'No app', link: '/hospedar-no-app' },
        { text: 'No Railway', link: '/hospedar-no-railway' },
        { text: 'Numa VPS', link: '/hospedar-em-vps' },
      ],
    },
    {
      text: 'Segurança',
      items: [
        { text: 'Privacidade e segurança', link: '/privacidade' },
        { text: 'Verificar downloads', link: '/verificar-downloads' },
      ],
    },
    { text: 'Ajuda', items: [{ text: 'Solução de problemas', link: '/solucao-de-problemas' }] },
  ];
}

function sidebarEn(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: 'Start',
      items: [
        { text: 'Download', link: '/en/download' },
        { text: 'Getting started', link: '/en/getting-started' },
      ],
    },
    {
      text: 'Host',
      items: [
        { text: 'In the app', link: '/en/host-in-app' },
        { text: 'On Railway', link: '/en/host-on-railway' },
        { text: 'On a VPS', link: '/en/host-on-vps' },
      ],
    },
    {
      text: 'Security',
      items: [
        { text: 'Privacy and security', link: '/en/privacy' },
        { text: 'Verify downloads', link: '/en/verify-downloads' },
      ],
    },
    { text: 'Help', items: [{ text: 'Troubleshooting', link: '/en/troubleshooting' }] },
  ];
}

const footer = {
  pt: { message: 'Código aberto sob a licença GPL-3.0-or-later.', copyright: 'GhostLink — versão beta' },
  en: { message: 'Open source under the GPL-3.0-or-later license.', copyright: 'GhostLink — beta' },
};

export default defineConfig({
  base: BASE,
  title: 'GhostLink',
  cleanUrls: true,
  appearance: 'dark',
  lastUpdated: false,
  // Vite's cache stays out of the source tree (and out of git and ESLint).
  cacheDir: '../node_modules/.cache/vitepress',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#5865f2' }],
    // Invite pages carry a server address in their fragment; links out never say where they came from.
    ['meta', { name: 'referrer', content: 'no-referrer' }],
  ],
  locales: {
    root: {
      label: 'Português',
      lang: 'pt-BR',
      description: 'Chat de texto e voz gratuito e de código aberto, com servidor próprio e sem conta.',
      themeConfig: {
        nav: [
          { text: 'Baixar', link: '/download' },
          { text: 'Primeiros passos', link: '/primeiros-passos' },
          { text: 'Hospedar', link: '/hospedar-no-app', activeMatch: '^/hospedar' },
          { text: 'Privacidade', link: '/privacidade' },
        ],
        sidebar: sidebarPt(),
        footer: footer.pt,
        outline: { label: 'Nesta página', level: [2, 3] },
        docFooter: { prev: 'Anterior', next: 'Próxima' },
        darkModeSwitchLabel: 'Aparência',
        lightModeSwitchTitle: 'Usar o tema claro',
        darkModeSwitchTitle: 'Usar o tema escuro',
        sidebarMenuLabel: 'Menu',
        returnToTopLabel: 'Voltar ao topo',
        langMenuLabel: 'Idioma',
        skipToContentLabel: 'Pular para o conteúdo',
        notFound: {
          title: 'Página não encontrada',
          quote: 'Esta página sumiu como um fantasma.',
          linkLabel: 'Ir para o início',
          linkText: 'Voltar ao início',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      description: 'Free and open-source text and voice chat with your own server and no account.',
      themeConfig: {
        nav: [
          { text: 'Download', link: '/en/download' },
          { text: 'Getting started', link: '/en/getting-started' },
          { text: 'Host', link: '/en/host-in-app', activeMatch: '^/en/host' },
          { text: 'Privacy', link: '/en/privacy' },
        ],
        sidebar: sidebarEn(),
        footer: footer.en,
        outline: { label: 'On this page', level: [2, 3] },
        notFound: {
          title: 'Page not found',
          quote: 'This page vanished like a ghost.',
          linkLabel: 'Go to the home page',
          linkText: 'Back home',
        },
      },
    },
  },
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    siteTitle: 'GhostLink',
    socialLinks: [{ icon: 'github', link: REPO_URL, ariaLabel: 'GitHub' }],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: 'Buscar', buttonAriaLabel: 'Buscar' },
              modal: {
                displayDetails: 'Mostrar a lista detalhada',
                resetButtonTitle: 'Limpar a busca',
                backButtonTitle: 'Fechar a busca',
                noResultsText: 'Nada encontrado para',
                footer: { selectText: 'abrir', navigateText: 'navegar', closeText: 'fechar' },
              },
            },
          },
        },
      },
    },
  },
});

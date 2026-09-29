import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, formatWebLink, toBase64Url } from '@ghostlink/shared';
import type { DefaultTheme } from 'vitepress';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { WEB_SITE_BASE } from '../../apps/server/src/version.js';
import config from '../../docs-site/.vitepress/config.mjs';

// The VitePress site (spec §16): GitHub Pages project site, pt-BR at the root and English under
// /en/, the /j/ invite page (spec §3.5), local search, no trackers.
const root = fileURLToPath(new URL('../../', import.meta.url));
const site = join(root, 'docs-site');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'dist' || e.name === 'cache' || e.name === 'node_modules') return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path) : [path];
  });
}
const files = walk(site).map((f) => relative(site, f).replaceAll('\\', '/'));
const pages = files.filter((f) => f.endsWith('.md'));

/** `/en/host-on-vps` → `en/host-on-vps.md`, `/en/` → `en/index.md`, `/j/` → `j/index.md`. */
function pageFor(link: string): string {
  const path = link.split('#')[0]!.replace(/^\//, '');
  return path === '' || path.endsWith('/') ? `${path}index.md` : `${path}.md`;
}

function frontmatter(page: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(`docs-site/${page}`).replaceAll('\r\n', '\n'));
  return m ? (parse(m[1]!) as Record<string, unknown>) : {};
}

const locales = config.locales!;
const themeOf = (key: 'root' | 'en') => locales[key]!.themeConfig as DefaultTheme.Config;
const sidebarLinks = (key: 'root' | 'en') =>
  (themeOf(key).sidebar as DefaultTheme.SidebarItem[]).flatMap((group) => (group.items ?? []).map((i) => i.link!));
const navLinks = (key: 'root' | 'en') => (themeOf(key).nav as DefaultTheme.NavItemWithLink[]).map((i) => i.link);

describe('site configuration', () => {
  it('is the GitHub Pages project site the app and the release point to', () => {
    expect(config.base).toBe('/ghostlink/');
    expect(SITE_URL).toBe(`https://gestao-in7eligente.github.io${config.base}`);
    expect(config.cleanUrls).toBe(true);
  });

  it('serves Portuguese at the root and English under /en/, with local search', () => {
    expect(locales.root).toMatchObject({ label: 'Português', lang: 'pt-BR' });
    expect(locales.en).toMatchObject({ label: 'English', lang: 'en-US', link: '/en/' });
    expect(config.themeConfig?.search?.provider).toBe('local');
  });

  it('adds no third-party script, font or stylesheet and sends no referrer', () => {
    const head = config.head ?? [];
    expect(head.filter(([tag]) => tag === 'script' || tag === 'style')).toEqual([]);
    for (const [tag, attrs] of head) {
      for (const value of Object.values(attrs)) {
        if (tag === 'link') expect(value).not.toMatch(/^(https?:)?\/\//);
      }
    }
    expect(head).toContainEqual(['meta', { name: 'referrer', content: 'no-referrer' }]);
  });

  it('keeps the Vite cache outside the source tree', () => {
    expect(config.cacheDir).toBe('../node_modules/.cache/vitepress');
  });
});

describe('site pages', () => {
  it('has a page for every navigation and sidebar link', () => {
    for (const key of ['root', 'en'] as const) {
      for (const link of [...navLinks(key), ...sidebarLinks(key)]) {
        expect(pages, `${key}: ${link}`).toContain(pageFor(link));
      }
    }
  });

  it('has every page in both languages', () => {
    const pt = sidebarLinks('root');
    const en = sidebarLinks('en');
    expect(en).toHaveLength(pt.length);
    expect(en.every((link) => link.startsWith('/en/'))).toBe(true);
    const ptPages = pages.filter((p) => !p.startsWith('en/')).sort();
    const enPages = pages.filter((p) => p.startsWith('en/')).map((p) => p.slice(3)).sort();
    expect(enPages).toHaveLength(ptPages.length);
    expect(enPages).toEqual(expect.arrayContaining(['index.md', 'j/index.md', 'download.md']));
  });

  it('serves the /j/ invite page where the server builds web links, out of search and indexes', () => {
    const keyId = toBase64Url(new Uint8Array(32).fill(3));
    const link = formatWebLink({ addresses: ['203.0.113.7:7700'], serverKeyId: keyId }, SITE_URL);
    expect(link.startsWith(`${SITE_URL}j/#GL1-`)).toBe(true);
    for (const page of ['j/index.md', 'en/j/index.md']) {
      expect(pages).toContain(page);
      expect(frontmatter(page)).toMatchObject({ search: false, head: [['meta', { name: 'robots', content: 'noindex' }]] });
    }
    expect(read('docs-site/j/index.md')).toMatch(/<JoinInvite auto-lang \/>/);
  });

  it.skipIf(WEB_SITE_BASE.endsWith('.invalid'))('is where the server points web invites', () => {
    expect(`${WEB_SITE_BASE.replace(/\/+$/, '')}/`).toBe(SITE_URL);
  });

  it('has every page the release notes link to', () => {
    const notes = readdirSync(join(root, 'release-notes')).map((f) => read(`release-notes/${f}`)).join('\n');
    const links = [...notes.matchAll(/https:\/\/gestao-in7eligente\.github\.io\/ghostlink(\/[^\s)]*)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(pages, link).toContain(pageFor(link));
  });

  it('gives every page a title and a description', () => {
    for (const page of pages) {
      const fm = frontmatter(page);
      expect(fm.title, page).toEqual(expect.any(String));
      if (fm.layout !== 'home') expect(fm.description, page).toEqual(expect.any(String));
    }
  });
});

describe('site privacy (no trackers, spec §3.5/§16)', () => {
  const code = files.filter((f) => /\.(vue|ts|mts|md)$/.test(f));

  it('loads no external script, frame or image', () => {
    for (const file of code) {
      const text = read(`docs-site/${file}`);
      expect(text, file).not.toMatch(/<script[^>]+src=["']?(https?:)?\/\//i);
      expect(text, file).not.toMatch(/<(iframe|img|link|source)[^>]+(src|href)=["']?(https?:)?\/\//i);
    }
  });

  it('calls the network only from the download helper, and only the GitHub API', () => {
    const callers = code.filter((file) => /\bfetch\b|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/.test(read(`docs-site/${file}`)));
    expect(callers).toEqual(['.vitepress/theme/lib/download.ts']);
    expect(read('docs-site/.vitepress/theme/lib/download.ts')).toMatch(/fetchImpl\(LATEST_RELEASE_API_URL,/);
  });

  it('reads the invite only from the fragment, in the browser', () => {
    const invite = read('docs-site/.vitepress/theme/components/JoinInvite.vue');
    expect(invite).toMatch(/inviteFromFragment\(window\.location\.hash\)/);
    expect(invite).not.toMatch(/location\.search|localStorage|sessionStorage|document\.cookie/);
  });
});

describe('site brand', () => {
  it('uses the blurple brand color and the ghost logo', () => {
    const css = read('docs-site/.vitepress/theme/style.css');
    expect(css).toMatch(/--gl-blurple: #5865f2;/);
    expect(css).toMatch(/--vp-c-brand-3: #5865f2;/);
    expect(css).toMatch(/--vp-button-brand-bg: var\(--gl-blurple\);/);
    for (const file of brandFiles()) expect(read(`docs-site/${file}`).toLowerCase(), file).not.toMatch(/#5eead4|#99f6e4/); // the old aqua
    const logo = read('docs-site/public/logo.svg');
    expect(logo).toMatch(/fill="#5865f2"/);
    const mark = join(root, 'apps/desktop/src/renderer/components/GhostMark.tsx');
    if (existsSync(mark)) {
      const ghost = /GHOST_PATH =\s*'([^']+)'/.exec(readFileSync(mark, 'utf8'))?.[1];
      expect(ghost).toBeDefined();
      expect(logo).toContain(`d="${ghost}"`);
    }
  });

  function brandFiles(): string[] {
    return files.filter((f) => /\.(vue|ts|mts|md|css|svg)$/.test(f));
  }
});

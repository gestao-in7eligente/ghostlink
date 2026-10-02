import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { markdownToPlainText, parseMarkdown, safeLink, type Block } from '../../src/renderer/features/chat/markdown.js';
import { renderMarkdown, type MarkdownContext } from '../../src/renderer/features/chat/markdownRender.js';

const USER = 'a'.repeat(32);
const ROLE = 'R'.repeat(26);

const opened: string[] = [];
const ctx: MarkdownContext = {
  classes: { paragraph: 'p', quote: 'q', codeBlock: 'cb', code: 'c', link: 'l', mention: 'm', mentionMe: 'me' },
  userName: (id) => (id === USER ? 'Ana' : null),
  role: (id) => (id === ROLE ? { name: 'Mods', color: '#ed4245' } : null),
  pingsMe: (kind, id) => kind === 'user' && id === USER,
  labels: { everyone: '@todos', formerMember: 'ex-membro', deletedRole: 'cargo-apagado' },
  openLink: (url) => opened.push(url),
};

const html = (src: string, everyone = false) => renderToStaticMarkup(createElement('div', null, renderMarkdown(parseMarkdown(src, { everyone }), ctx)));
const inline = (src: string) => {
  const blocks = parseMarkdown(src);
  expect(blocks).toHaveLength(1);
  const [b] = blocks as [Block];
  if (b.k === 'codeblock') throw new Error('expected text');
  return b.children;
};

describe('markdown: formatting', () => {
  it('bold, italic, underline, strike and inline code', () => {
    expect(html('**negrito** *itálico* _também_ __sublinhado__ ~~riscado~~ `código`')).toBe(
      '<div><div class="p"><strong>negrito</strong> <em>itálico</em> <em>também</em> <u>sublinhado</u> <s>riscado</s> <code class="c">código</code></div></div>',
    );
  });

  it('nests formatting and keeps markup inside code literal', () => {
    expect(html('**a *b* c**')).toBe('<div><div class="p"><strong>a <em>b</em> c</strong></div></div>');
    expect(html('`**not bold**`')).toBe('<div><div class="p"><code class="c">**not bold**</code></div></div>');
  });

  it('leaves unclosed or empty markers, snake_case and spaced stars alone', () => {
    expect(inline('**abc')).toEqual([{ k: 'text', text: '**abc' }]);
    expect(inline('snake_case_name')).toEqual([{ k: 'text', text: 'snake_case_name' }]);
    expect(inline('2 * 3 * 4')).toEqual([{ k: 'text', text: '2 * 3 * 4' }]);
    expect(inline('****')).toEqual([{ k: 'text', text: '****' }]);
    expect(inline('a ` b')).toEqual([{ k: 'text', text: 'a ` b' }]);
  });

  it('backslash escapes markup characters', () => {
    expect(inline('\\*\\*literal\\*\\*')).toEqual([{ k: 'text', text: '**literal**' }]);
  });

  it('keeps line breaks, quotes and fenced code blocks with an optional language', () => {
    expect(parseMarkdown('linha 1\nlinha 2\n> citação\n> mais\nfim\n```ts\nconst x = 1;\n```\ndepois')).toEqual([
      { k: 'paragraph', children: [{ k: 'text', text: 'linha 1' }, { k: 'br' }, { k: 'text', text: 'linha 2' }] },
      { k: 'quote', children: [{ k: 'text', text: 'citação' }, { k: 'br' }, { k: 'text', text: 'mais' }] },
      { k: 'paragraph', children: [{ k: 'text', text: 'fim' }] },
      { k: 'codeblock', lang: 'ts', text: 'const x = 1;' },
      { k: 'paragraph', children: [{ k: 'text', text: 'depois' }] },
    ]);
  });

  it('an unclosed fence is plain text', () => {
    expect(parseMarkdown('```\nsem fim')).toEqual([{ k: 'paragraph', children: [{ k: 'text', text: '```' }, { k: 'br' }, { k: 'text', text: 'sem fim' }] }]);
  });
});

describe('markdown: links', () => {
  it('autolinks http(s) URLs, without trailing punctuation', () => {
    expect(inline('veja https://example.com/a?b=1, e (http://x.test/wiki/A_(b)).')).toEqual([
      { k: 'text', text: 'veja ' },
      { k: 'link', url: 'https://example.com/a?b=1' },
      { k: 'text', text: ', e (' },
      { k: 'link', url: 'http://x.test/wiki/A_(b)' },
      { k: 'text', text: ').' },
    ]);
  });

  it('opens links only through the confirming handler', () => {
    const markup = html('https://example.com');
    expect(markup).toBe('<div><div class="p"><a href="https://example.com" class="l" rel="noreferrer noopener" title="https://example.com">https://example.com</a></div></div>');
    const [paragraph] = renderMarkdown(parseMarkdown('https://example.com'), ctx) as unknown as [{ props: { children: [{ props: { onClick(e: unknown): void } }] } }];
    let prevented = false;
    paragraph.props.children[0].props.onClick({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(opened).toContain('https://example.com');
  });

  it('never links other schemes, credentials, or masked links', () => {
    for (const src of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/Windows', 'vbscript:x', '[clique](javascript:alert(1))', 'https://bank.test@evil.test/']) {
      expect(html(src), src).not.toContain('<a');
    }
    expect(safeLink('https://user:pw@x.test')).toBeNull();
    expect(safeLink('https://x.test/ok')).toBe('https://x.test/ok');
  });

  it('a URL stops at quotes and angle brackets, so it cannot break out of the attribute', () => {
    const markup = html('https://x.test/"><img src=x onerror=alert(1)>');
    expect(markup).toContain('href="https://x.test/"');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('markdown: channel links (ghostlink://channel/…, v0.5.0)', () => {
  const KEY = 'k'.repeat(43);
  const HERE = 'H'.repeat(26);
  const link = (channelId: string, key = KEY) => `ghostlink://channel/${key}/${channelId}`;
  const openedChannels: string[] = [];
  const withChannels: MarkdownContext = {
    ...ctx,
    classes: { ...ctx.classes, channel: 'ch', channelUnknown: 'chx' },
    channels: {
      chip: (key, channelId) => (key !== KEY ? { kind: 'unknown' } : channelId === HERE ? { kind: 'here', name: 'geral' } : { kind: 'elsewhere', server: 'Casa' }),
      open: (key, channelId) => openedChannels.push(`${key}/${channelId}`),
      labels: { channel: 'canal', unknown: 'canal desconhecido' },
    },
  };
  const render = (src: string, c: MarkdownContext = withChannels) => renderToStaticMarkup(createElement('div', null, renderMarkdown(parseMarkdown(src), c)));

  it('reads an exact channel link, without trailing punctuation; anything else stays text', () => {
    expect(inline(`veja ${link(HERE)}.`)).toEqual([
      { k: 'text', text: 'veja ' },
      { k: 'channel', serverKeyId: KEY, channelId: HERE, raw: link(HERE) },
      { k: 'text', text: '.' },
    ]);
    for (const src of [link(HERE.toLowerCase()), `${link(HERE)}/x`, `ghostlink://join?h=1.2.3.4:7700&k=${KEY}`, `ghostlink://channel/${KEY}`, `x${link(HERE)}`, 'steam://run/1', 'ghostlink://evil']) {
      expect(inline(src).every((n) => n.k === 'text'), src).toBe(true);
    }
  });

  it('a chip: "#name" here, "<server> › #canal" on another server, both opening it; a grey one otherwise', () => {
    expect(render(link(HERE))).toBe(`<div><div class="p"><span role="link" tabindex="0" class="m ch" title="${link(HERE)}">#geral</span></div></div>`);
    expect(render(link('E'.repeat(26)))).toContain('>Casa › #canal</span>');
    expect(render(link(HERE, 'z'.repeat(43)))).toBe(`<div><div class="p"><span class="m chx" title="${link(HERE, 'z'.repeat(43))}">#canal desconhecido</span></div></div>`);
    const [paragraph] = renderMarkdown(parseMarkdown(link(HERE)), withChannels) as unknown as [{ props: { children: [{ props: { onClick(e: unknown): void } }] } }];
    paragraph.props.children[0].props.onClick({ preventDefault: () => undefined });
    expect(openedChannels).toEqual([`${KEY}/${HERE}`]);
  });

  it('stays plain text where nothing resolves channels, and is never an anchor', () => {
    expect(render(link(HERE), ctx)).toBe(`<div><div class="p">${link(HERE)}</div></div>`);
    expect(render(link(HERE))).not.toContain('<a');
  });
});

describe('markdown: mentions', () => {
  it('renders user and role tokens with names; unknown ones are labelled', () => {
    expect(html(`oi <@${USER}> e <@${'b'.repeat(32)}> e <@&${ROLE}> e <@&${'Z'.repeat(26)}>`)).toBe(
      '<div><div class="p">oi <span class="m me">@Ana</span> e <span class="m">@ex-membro</span> e ' +
        '<span class="m" style="color:#ed4245;background-color:color-mix(in srgb, #ed4245 15%, transparent)">@Mods</span> e <span class="m">@cargo-apagado</span></div></div>',
    );
  });

  it('@everyone is a mention only when the server accepted it', () => {
    expect(html('@everyone olá', true)).toBe('<div><div class="p"><span class="m me">@todos</span> olá</div></div>');
    expect(html('@everyone olá', false)).toBe('<div><div class="p">@everyone olá</div></div>');
    expect(html('mail@everyone.com', true)).toBe('<div><div class="p">mail@everyone.com</div></div>');
  });

  it('malformed tokens are text', () => {
    expect(inline(`<@${USER.slice(1)}> <@&abc>`)).toEqual([{ k: 'text', text: `<@${USER.slice(1)}> <@&abc>` }]);
  });
});

describe('markdown: injection (content never becomes HTML)', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '**<iframe src="https://evil.test"></iframe>**',
    '```html\n<script>alert(1)</script>\n```',
    '`<style>body{display:none}</style>`',
    '> <a href="javascript:alert(1)">x</a>',
    '<@&" onmouseover="alert(1)>',
  ])('%s is escaped text', (src) => {
    const markup = html(src);
    // No dangerous element, and no event-handler attribute inside any real tag.
    expect(markup).not.toMatch(/<(script|img|iframe|style)\b/i);
    expect(markup).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
    // The only anchors are plain http(s) autolinks.
    for (const m of markup.matchAll(/<a\b[^>]*href="([^"]*)"/g)) expect(m[1]).toMatch(/^https?:\/\/[^"<>]+$/);
  });
});

describe('markdown: plain text', () => {
  it('strips markup and names mentions for notifications', () => {
    const names = { user: (id: string) => (id === USER ? 'Ana' : 'ex-membro'), role: () => 'Mods', everyone: '@todos' };
    expect(markdownToPlainText(parseMarkdown(`**oi** <@${USER}>, veja \`x\` <@&${ROLE}> @everyone`, { everyone: true }), names)).toBe('oi @Ana, veja x @Mods @todos');
  });
});

describe('markdown: pathological input stays linear (ReDoS)', () => {
  const cases: [string, string][] = [
    ['stars', '*'.repeat(100_000)],
    ['double stars', '**a'.repeat(40_000)],
    ['single stars with text', '*a '.repeat(40_000)],
    ['underscores', '_a'.repeat(50_000)],
    ['snake', 'a_'.repeat(50_000)],
    ['backticks', '`'.repeat(100_000)],
    ['tildes', '~~x'.repeat(40_000)],
    ['fences', '```'.repeat(40_000)],
    ['quotes', '> x\n'.repeat(30_000)],
    ['backslashes', '\\'.repeat(100_000)],
    ['open parens url', `https://x.test/${'('.repeat(100_000)}`],
    ['close parens url', `https://x.test/${')'.repeat(100_000)}`],
    ['url prefixes', 'https://'.repeat(20_000)],
    ['long url', `https://x.test/${'a'.repeat(100_000)} `.repeat(3)],
    ['mention starts', '<@'.repeat(50_000)],
    ['mixed nesting', '**_~~*'.repeat(20_000)],
    ['everyone', '@everyone@'.repeat(20_000)],
  ];
  /** Parse + render time of `src`, in ms. */
  const timeOf = (src: string): number => {
    const started = performance.now();
    renderToStaticMarkup(createElement('div', null, renderMarkdown(parseMarkdown(src, { everyone: true }), ctx)));
    return performance.now() - started;
  };
  const WELL_FORMED = `**negrito** _itálico_ ~~riscado~~ \`código\` <@${USER}> https://x.test/a @everyone\n`;

  // Each case takes well under 200 ms on an idle machine, but the full suite can slow a run
  // down twentyfold (1.8 s was seen). Catastrophic backtracking on inputs this long takes
  // seconds to minutes, on every run. So the limit is 20× a well-formed document of the same
  // length timed just before (a busy machine slows both), at least 1.5 s, and a case fails
  // only when 3 tries in a row exceed it.
  it.each(cases)('%s', (_name, src) => {
    const baseline = WELL_FORMED.repeat(Math.ceil(src.length / WELL_FORMED.length)).slice(0, src.length);
    const failures: string[] = [];
    while (failures.length < 3) {
      const limit = Math.max(1_500, 20 * timeOf(baseline));
      const took = timeOf(src);
      if (took < limit) break;
      failures.push(`${Math.round(took)} ms (limit ${Math.round(limit)} ms)`);
    }
    expect(failures.length, `parse + render took ${failures.join(', ')}`).toBeLessThan(3);
  });
});

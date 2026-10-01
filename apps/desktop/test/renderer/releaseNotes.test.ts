import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_NOTE_ITEMS, parseInline, releaseChanges, safeLinkUrl } from '../../src/renderer/features/updates/releaseNotes.js';

const NOTES = [
  '> **Beta.** Algo novo. *Something new.* — [English below](#english)',
  '',
  '## Português',
  '',
  '### O que mudou',
  '',
  '- **Transmitir a tela:** escolha uma tela',
  '  e clique em **Assistir**.',
  '- Rode o `install.sh` desta release.',
  '',
  'Um parágrafo que não é item.',
  '',
  '### Atualizar',
  '',
  '- Não é novidade.',
  '',
  '## English',
  '',
  '### What changed',
  '',
  '- **Screen sharing:** pick a screen.',
  '- See https://gestao-in7eligente.github.io/ghostlink/en/host-on-vps.',
  '',
  '### Updating',
  '',
  '- Not news.',
].join('\n');

const text = (t: string) => ({ k: 'text', text: t });

describe('releaseChanges: the "O que mudou" / "What changed" bullets', () => {
  it('takes the section of the app language and nothing around it', () => {
    expect(releaseChanges(NOTES, 'pt-BR')).toEqual([
      [{ k: 'bold', children: [text('Transmitir a tela:')] }, text(' escolha uma tela e clique em '), { k: 'bold', children: [text('Assistir')] }, text('.')],
      [text('Rode o '), { k: 'code', text: 'install.sh' }, text(' desta release.')],
    ]);
    expect(releaseChanges(NOTES, 'en')).toEqual([
      [{ k: 'bold', children: [text('Screen sharing:')] }, text(' pick a screen.')],
      [text('See '), { k: 'link', text: 'https://gestao-in7eligente.github.io/ghostlink/en/host-on-vps', url: 'https://gestao-in7eligente.github.io/ghostlink/en/host-on-vps' }, text('.')],
    ]);
  });

  it('reads Windows line endings and GitHub bodies alike', () => {
    expect(releaseChanges(NOTES.replace(/\n/g, '\r\n'), 'pt-BR')).toEqual(releaseChanges(NOTES, 'pt-BR'));
  });

  it('is null when the language or its "what changed" part is missing', () => {
    const ptOnly = NOTES.slice(0, NOTES.indexOf('## English'));
    expect(releaseChanges(ptOnly, 'en')).toBeNull();
    expect(releaseChanges(ptOnly, 'pt-BR')).toHaveLength(2);
    expect(releaseChanges('## English\n\n### Updating\n\n- x', 'en')).toBeNull();
    expect(releaseChanges('', 'pt-BR')).toBeNull();
    // "What changed" under the Portuguese heading is not the English section.
    expect(releaseChanges('## Português\n\n### What changed\n\n- x', 'en')).toBeNull();
  });

  it('gives an empty list for a section without bullets', () => {
    expect(releaseChanges('## English\n\n### What changed\n\nJust a paragraph.\n', 'en')).toEqual([]);
  });

  it('ignores code blocks, even with a heading-like line inside', () => {
    const md = '## English\n\n### What changed\n\n- one\n\n```bash\n## Português\n- not a bullet\n```\n\n- two\n';
    expect(releaseChanges(md, 'en')).toEqual([[text('one')], [text('two')]]);
  });

  it('accepts *, + and numbered items, and stops at the next heading', () => {
    const md = '## English\n### What changed\n* a\n+ b\n1. c\n#### More\n- d\n## Other\n- e';
    expect(releaseChanges(md, 'en')).toEqual([[text('a')], [text('b')], [text('c')], [text('d')]]);
  });

  it('keeps a bounded number of bullets', () => {
    const md = `## English\n### What changed\n${Array.from({ length: MAX_NOTE_ITEMS + 10 }, (_, i) => `- item ${i}`).join('\n')}`;
    expect(releaseChanges(md, 'en')).toHaveLength(MAX_NOTE_ITEMS);
  });

  it('reads the real notes of the shipped versions', () => {
    const real = readFileSync(new URL('../../../../release-notes/0.2.2.md', import.meta.url), 'utf8');
    const pt = releaseChanges(real, 'pt-BR')!;
    const en = releaseChanges(real, 'en')!;
    expect(pt).toHaveLength(7);
    expect(en).toHaveLength(7);
    expect(pt[0]![0]).toEqual({ k: 'bold', children: [text('Transmitir a tela:')] });
    expect(en[0]![0]).toEqual({ k: 'bold', children: [text('Screen sharing:')] });
  });
});

describe('parseInline', () => {
  it('reads bold, with code and links inside it', () => {
    expect(parseInline('**see `x` and https://a.example/b**!')).toEqual([
      { k: 'bold', children: [text('see '), { k: 'code', text: 'x' }, text(' and '), { k: 'link', text: 'https://a.example/b', url: 'https://a.example/b' }] },
      text('!'),
    ]);
  });

  it('reads code literally, markup and all', () => {
    expect(parseInline('run `**not bold** <b>` now')).toEqual([text('run '), { k: 'code', text: '**not bold** <b>' }, text(' now')]);
    expect(parseInline('``a ` b``')).toEqual([{ k: 'code', text: 'a ` b' }]);
  });

  it('reads Markdown links, autolinks and bare URLs', () => {
    expect(parseInline('[the guide](https://example.com/g?a=1) and <https://example.com/x>')).toEqual([
      { k: 'link', text: 'the guide', url: 'https://example.com/g?a=1' },
      text(' and '),
      { k: 'link', text: 'https://example.com/x', url: 'https://example.com/x' },
    ]);
    expect(parseInline('(veja https://example.com/a_(b)).')).toEqual([
      text('(veja '),
      { k: 'link', text: 'https://example.com/a_(b)', url: 'https://example.com/a_(b)' },
      text(').'),
    ]);
  });

  it('never makes a link of anything but http(s)', () => {
    expect(parseInline('[English below](#english)')).toEqual([text('English below')]);
    expect(parseInline('[click](javascript:alert(1))')).toEqual([text('click)')]);
    expect(parseInline('[empty]()')).toEqual([text('empty')]);
    expect(parseInline('[x](https://user:pw@example.com/)')).toEqual([text('x')]);
    expect(parseInline('<javascript:alert(1)>')).toEqual([text('<javascript:alert(1)>')]);
    expect(parseInline('<https://a.example/x y>')).toEqual([text('<'), { k: 'link', text: 'https://a.example/x', url: 'https://a.example/x' }, text(' y>')]);
  });

  it('leaves unknown or broken markup as plain text', () => {
    for (const raw of [
      '*italic* and _under_ and ~~strike~~',
      '<b>html</b> & <img src=x onerror=alert(1)>',
      '![image](https://example.com/a.png)',
      '**not closed',
      '** spaced **',
      'a `lonely backtick',
      '[no target] and [two](words here)',
      '# not a heading here',
    ]) {
      expect(parseInline(raw).map((n) => (n.k === 'text' ? n.text : `<${n.k}>`)).join(''), raw).toBe(raw);
    }
  });

  it('honours backslash escapes', () => {
    expect(parseInline('\\*\\*not bold\\*\\* and \\`x\\`')).toEqual([text('**not bold** and `x`')]);
  });

  it('does not take a URL glued to a word', () => {
    expect(parseInline('xhttps://example.com')).toEqual([text('xhttps://example.com')]);
  });

  it('stays fast on hostile input', () => {
    const hostile = '**'.repeat(20_000) + '`'.repeat(20_000) + '['.repeat(20_000) + ']' + '![x]('.repeat(5_000) + '<https://'.repeat(5_000) + 'https://'.repeat(5_000);
    const started = performance.now();
    parseInline(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('safeLinkUrl', () => {
  it('keeps plain http(s) links and refuses the rest', () => {
    expect(safeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLinkUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'https://u@example.com', '#english', '', `https://e.com/${'a'.repeat(3000)}`]) {
      expect(safeLinkUrl(bad), bad).toBeNull();
    }
  });
});

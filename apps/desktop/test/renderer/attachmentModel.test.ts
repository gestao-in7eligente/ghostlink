import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENTS,
  addToTray,
  fileBadge,
  fitImage,
  formatSize,
  kindFromMime,
  middleEllipsis,
  mosaicRows,
  percent,
  summarizeRejections,
} from '../../src/renderer/features/attachments/attachmentModel.js';

describe('attachment kinds and file icons (spec 2026-10-01-anexos §1)', () => {
  it('guesses the kind from the reported type, the same four the server shows inline', () => {
    expect(kindFromMime('image/png')).toBe('image');
    expect(kindFromMime('IMAGE/JPEG')).toBe('image');
    expect(kindFromMime('image/webp')).toBe('image');
    expect(kindFromMime('image/gif')).toBe('image');
    expect(kindFromMime('video/mp4')).toBe('video');
    expect(kindFromMime('video/webm')).toBe('video');
    expect(kindFromMime('audio/mpeg')).toBe('audio');
    expect(kindFromMime('audio/ogg; codecs=opus')).toBe('audio');
    // Anything else is a card: no inline SVG (scripts), no TIFF, no PDF viewer.
    for (const other of ['image/svg+xml', 'image/tiff', 'application/pdf', 'text/html', '', 'video/quicktime']) expect(kindFromMime(other)).toBe('file');
  });

  it('picks a card icon from the extension', () => {
    expect(fileBadge('Relatório.PDF', 'file')).toBe('pdf');
    expect(fileBadge('fotos.zip', 'file')).toBe('archive');
    expect(fileBadge('contas.xlsx', 'file')).toBe('sheet');
    expect(fileBadge('aula.pptx', 'file')).toBe('slides');
    expect(fileBadge('notas.txt', 'file')).toBe('document');
    expect(fileBadge('app.ts', 'file')).toBe('code');
    expect(fileBadge('Makefile', 'file')).toBe('generic');
    expect(fileBadge('.bashrc', 'file')).toBe('generic');
    expect(fileBadge('musica.mp3', 'audio')).toBe('audio');
  });
});

describe('size labels', () => {
  it('uses powers of 1024 with one decimal under 10, in the reader language', () => {
    expect(formatSize(0, 'pt-BR')).toBe('0 B');
    expect(formatSize(820, 'pt-BR')).toBe('820 B');
    expect(formatSize(1024, 'en')).toBe('1 KB');
    expect(formatSize(1536, 'pt-BR')).toBe('1,5 KB');
    expect(formatSize(1536, 'en')).toBe('1.5 KB');
    expect(formatSize(14 * 1024 + 300, 'en')).toBe('14 KB');
    expect(formatSize(25 * 1024 * 1024, 'pt-BR')).toBe('25 MB');
    expect(formatSize(10_240 * 1024 * 1024, 'en')).toBe('10 GB');
  });

  it('never shows 1024 of a unit, nor anything odd for bad input', () => {
    expect(formatSize(1024 * 1024 - 1, 'en')).toBe('1 MB');
    expect(formatSize(-5, 'en')).toBe('0 B');
    expect(formatSize(Number.NaN, 'en')).toBe('0 B');
  });

  it('cuts long names in the middle and keeps the extension', () => {
    expect(middleEllipsis('curto.pdf')).toBe('curto.pdf');
    const cut = middleEllipsis(`${'a'.repeat(80)}.pdf`, 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith('….pdf')).toBe(true);
  });

  it('reports whole percentages', () => {
    expect(percent(0)).toBe(0);
    expect(percent(0.416)).toBe(41);
    expect(percent(0.999)).toBe(99);
    expect(percent(1)).toBe(100);
    expect(percent(Number.NaN)).toBe(0);
  });
});

describe('the tray rules', () => {
  const file = (name: string, size: number) => ({ name, size });
  const limits = { maxFiles: MAX_ATTACHMENTS, maxBytes: 25 * 1024 * 1024 };

  it('takes up to ten files in all, in order', () => {
    const current = Array.from({ length: 8 }, (_, i) => file(`f${i}`, 1));
    const { accepted, rejected } = addToTray(current, [file('a', 1), file('b', 2), file('c', 3)], limits);
    expect(accepted.map((f) => f.name)).toEqual(['a', 'b']);
    expect(rejected).toEqual([{ name: 'c', reason: 'tooMany' }]);
  });

  it('leaves out empty files and files over the server limit without using a place', () => {
    const { accepted, rejected } = addToTray([], [file('vazio', 0), file('grande.mp4', 26 * 1024 * 1024), file('ok.png', 10)], limits);
    expect(accepted.map((f) => f.name)).toEqual(['ok.png']);
    expect(rejected).toEqual([
      { name: 'vazio', reason: 'empty' },
      { name: 'grande.mp4', reason: 'tooLarge' },
    ]);
  });

  it('accepts any size when the limit is unknown', () => {
    expect(addToTray([], [file('x', 10 ** 9)], { maxFiles: 10, maxBytes: null }).accepted).toHaveLength(1);
  });

  it('summarizes one line per reason, naming the file when there is one', () => {
    expect(summarizeRejections([
      { name: 'a', reason: 'tooLarge' },
      { name: 'b', reason: 'tooMany' },
      { name: 'c', reason: 'tooLarge' },
    ])).toEqual([
      { reason: 'tooLarge', name: 'a', count: 2 },
      { reason: 'tooMany', name: 'b', count: 1 },
    ]);
  });
});

describe('image fit math', () => {
  it('fits inside 400×300 keeping the proportions, never enlarging', () => {
    expect(fitImage(4000, 3000)).toEqual({ width: 400, height: 300 });
    expect(fitImage(1920, 1080)).toEqual({ width: 400, height: 225 });
    expect(fitImage(300, 1200)).toEqual({ width: 75, height: 300 });
    expect(fitImage(120, 80)).toEqual({ width: 120, height: 80 });
    expect(fitImage(8192, 1)).toEqual({ width: 400, height: 1 });
  });

  it('has no size for unknown sides', () => {
    expect(fitImage(undefined, 100)).toBeNull();
    expect(fitImage(0, 100)).toBeNull();
    expect(fitImage(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('lays several images out in rows of up to three, the short row first', () => {
    expect(mosaicRows(1)).toEqual([1]);
    expect(mosaicRows(2)).toEqual([2]);
    expect(mosaicRows(3)).toEqual([3]);
    expect(mosaicRows(4)).toEqual([2, 2]);
    expect(mosaicRows(5)).toEqual([2, 3]);
    expect(mosaicRows(6)).toEqual([3, 3]);
    expect(mosaicRows(7)).toEqual([1, 3, 3]);
    expect(mosaicRows(10)).toEqual([1, 3, 3, 3]);
    for (let n = 1; n <= 10; n++) expect(mosaicRows(n).reduce((a, b) => a + b, 0)).toBe(n);
  });
});

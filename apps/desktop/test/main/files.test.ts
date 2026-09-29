import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fileTimestamp, freePath, readJsonFile, writeJsonAtomic } from '../../src/main/files.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const schema = z.object({ n: z.number() });
const fixed = () => new Date(2026, 8, 28, 14, 30, 5);

describe('fileTimestamp', () => {
  it('formats local time as yyyyMMdd-HHmmss with zero padding', () => {
    expect(fileTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
    expect(fileTimestamp(fixed())).toBe('20260928-143005');
  });
});

describe('freePath', () => {
  it('never returns a path that already exists', () => {
    const base = join(dir.path, 'identity.bin.bak-x');
    expect(freePath(base)).toBe(base);
    writeFileSync(base, 'a');
    expect(freePath(base)).toBe(`${base}-1`);
    writeFileSync(`${base}-1`, 'b');
    expect(freePath(base)).toBe(`${base}-2`);
  });
});

describe('writeJsonAtomic', () => {
  it('replaces the content and leaves no temp file behind', () => {
    const file = join(dir.path, 'x.json');
    writeJsonAtomic(file, { n: 1 });
    writeJsonAtomic(file, { n: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 2 });
    expect(readdirSync(dir.path)).toEqual(['x.json']);
  });

  it.skipIf(process.platform === 'win32')('makes the file owner-only (0600)', () => {
    const file = join(dir.path, 'x.json');
    writeJsonAtomic(file, { n: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('readJsonFile', () => {
  it('returns the fallback for a missing file without creating it', () => {
    const file = join(dir.path, 'missing.json');
    expect(readJsonFile(file, schema, () => ({ n: 7 }))).toEqual({ n: 7 });
    expect(existsSync(file)).toBe(false);
  });

  it('parses a valid file and strips unknown keys', () => {
    const file = join(dir.path, 'ok.json');
    writeFileSync(file, JSON.stringify({ n: 3, extra: true }));
    expect(readJsonFile(file, schema, () => ({ n: 0 }))).toEqual({ n: 3 });
  });

  it.each([
    ['broken JSON', '{"n": '],
    ['wrong shape', '{"n": "three"}'],
    ['empty file', ''],
  ])('keeps a %s aside as .corrupt-<timestamp> and falls back', (_label, content) => {
    const file = join(dir.path, 'bad.json');
    writeFileSync(file, content);
    expect(readJsonFile(file, schema, () => ({ n: 0 }), fixed)).toEqual({ n: 0 });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.corrupt-20260928-143005`, 'utf8')).toBe(content);
  });

  it('never overwrites an earlier corrupt copy', () => {
    const file = join(dir.path, 'bad.json');
    writeFileSync(file, 'first');
    readJsonFile(file, schema, () => ({ n: 0 }), fixed);
    writeFileSync(file, 'second');
    readJsonFile(file, schema, () => ({ n: 0 }), fixed);
    expect(readFileSync(`${file}.corrupt-20260928-143005`, 'utf8')).toBe('first');
    expect(readFileSync(`${file}.corrupt-20260928-143005-1`, 'utf8')).toBe('second');
  });
});

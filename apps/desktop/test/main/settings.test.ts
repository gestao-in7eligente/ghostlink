import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { SETTINGS_FILE, SettingsStore, localeFromSystem } from '../../src/main/settings.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const file = () => join(dir.path, SETTINGS_FILE);

function expectBadRequest(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('localeFromSystem (spec §11)', () => {
  it.each([
    ['pt-BR', 'pt-BR'], ['pt', 'pt-BR'], ['pt-PT', 'pt-BR'], ['pt_BR', 'pt-BR'], ['PT-br', 'pt-BR'],
    ['en-US', 'en'], ['es-ES', 'en'], ['ptx', 'en'], ['', 'en'],
  ])('%j → %s', (system, locale) => {
    expect(localeFromSystem(system)).toBe(locale);
  });
});

describe('SettingsStore', () => {
  it('starts from the system locale and an empty nickname, without writing a file', () => {
    expect(SettingsStore.load(dir.path, 'pt-BR').get()).toEqual({ locale: 'pt-BR', nickname: '' });
    expect(SettingsStore.load(dir.path, 'de-DE').get()).toEqual({ locale: 'en', nickname: '' });
    expect(existsSync(file())).toBe(false);
  });

  it('persists a patch and reloads it, ignoring the system locale afterwards', () => {
    const store = SettingsStore.load(dir.path, 'pt-BR');
    expect(store.set({ locale: 'en', nickname: 'Ana' })).toEqual({ locale: 'en', nickname: 'Ana' });
    expect(SettingsStore.load(dir.path, 'pt-BR').get()).toEqual({ locale: 'en', nickname: 'Ana' });
  });

  it('stores the nickname normalized like the server does (spec §7)', () => {
    const store = SettingsStore.load(dir.path, 'en');
    expect(store.set({ nickname: '  Ana\u202E  Maria ' }).nickname).toBe('Ana Maria');
  });

  it('rejects an invalid nickname or locale and changes nothing', () => {
    const store = SettingsStore.load(dir.path, 'en');
    store.set({ nickname: 'Ana' });
    const before = readFileSync(file(), 'utf8');
    expectBadRequest(() => store.set({ nickname: '\u200B\u3164' }));
    expectBadRequest(() => store.set({ nickname: 'a'.repeat(33) }));
    expectBadRequest(() => store.set({ locale: 'fr' as 'en' }));
    expect(store.get()).toEqual({ locale: 'en', nickname: 'Ana' });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('hands out copies, not its internal state', () => {
    const store = SettingsStore.load(dir.path, 'en');
    store.get().nickname = 'hacked';
    expect(store.get().nickname).toBe('');
  });

  it('recovers from a corrupt file with defaults and keeps the broken copy', () => {
    writeFileSync(file(), '{"version":1,"locale":"klingon"');
    expect(SettingsStore.load(dir.path, 'pt-PT').get()).toEqual({ locale: 'pt-BR', nickname: '' });
    expect(readdirSync(dir.path).some((f) => f.startsWith(`${SETTINGS_FILE}.corrupt-`))).toBe(true);
  });
});

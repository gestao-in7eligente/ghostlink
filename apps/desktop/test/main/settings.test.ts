import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtocolError } from '@ghostlink/shared';
import { HOSTED_DIR, HOST_FILE } from '../../src/main/hostManager.js';
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
    expect(SettingsStore.load(dir.path, 'pt-BR').get()).toEqual({ locale: 'pt-BR', nickname: '', closeToTray: true, desktopNotifications: true });
    expect(SettingsStore.load(dir.path, 'de-DE').get()).toEqual({ locale: 'en', nickname: '', closeToTray: true, desktopNotifications: true });
    expect(existsSync(file())).toBe(false);
  });

  it('persists a patch and reloads it, ignoring the system locale afterwards', () => {
    const store = SettingsStore.load(dir.path, 'pt-BR');
    expect(store.set({ locale: 'en', nickname: 'Ana', closeToTray: false, desktopNotifications: false })).toEqual({ locale: 'en', nickname: 'Ana', closeToTray: false, desktopNotifications: false });
    expect(SettingsStore.load(dir.path, 'pt-BR').get()).toEqual({ locale: 'en', nickname: 'Ana', closeToTray: false, desktopNotifications: false });
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
    expectBadRequest(() => store.set({ closeToTray: 'yes' as unknown as boolean }));
    expectBadRequest(() => store.set({ desktopNotifications: 1 as unknown as boolean }));
    expect(store.get()).toEqual({ locale: 'en', nickname: 'Ana', closeToTray: true, desktopNotifications: true });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('hands out copies, not its internal state', () => {
    const store = SettingsStore.load(dir.path, 'en');
    store.get().nickname = 'hacked';
    expect(store.get().nickname).toBe('');
  });

  it('recovers from a corrupt file with defaults and keeps the broken copy', () => {
    writeFileSync(file(), '{"version":1,"locale":"klingon"');
    expect(SettingsStore.load(dir.path, 'pt-PT').get()).toEqual({ locale: 'pt-BR', nickname: '', closeToTray: true, desktopNotifications: true });
    expect(readdirSync(dir.path).some((f) => f.startsWith(`${SETTINGS_FILE}.corrupt-`))).toBe(true);
  });
});

describe('SettingsStore: the tray (v0.3.2)', () => {
  const hostFile = () => join(dir.path, HOSTED_DIR, HOST_FILE);
  const writeHostFile = (content: string) => {
    mkdirSync(join(dir.path, HOSTED_DIR), { recursive: true });
    writeFileSync(hostFile(), content);
  };

  it('keeps an older settings file: closing to the tray is on, the notice not shown yet', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, locale: 'en', nickname: 'Ana' }));
    const store = SettingsStore.load(dir.path, 'pt-BR');
    expect(store.get()).toEqual({ locale: 'en', nickname: 'Ana', closeToTray: true, desktopNotifications: true });
    expect(store.trayNoticeShown()).toBe(false);
  });

  it('remembers the notice once ever, in settings.json, never in what the page gets', () => {
    const store = SettingsStore.load(dir.path, 'en');
    store.markTrayNoticeShown();
    expect(store.trayNoticeShown()).toBe(true);
    expect(store.get()).not.toHaveProperty('trayNoticeShown');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ trayNoticeShown: true, closeToTray: true, desktopNotifications: true });
    store.set({ nickname: 'Ana' }); // a later change keeps it
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(true);
  });

  it('migrates the flag hosted/host.json kept before, leaving that file alone', () => {
    const legacy = JSON.stringify({ version: 1, last: null, trayNoticeShown: true });
    writeHostFile(legacy);
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(true);
    SettingsStore.load(dir.path, 'en').set({ locale: 'pt-BR' });
    writeHostFile(JSON.stringify({ version: 1, last: null, trayNoticeShown: false }));
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(true); // settings.json has it now
    expect(readdirSync(join(dir.path, HOSTED_DIR))).toEqual([HOST_FILE]);
  });

  it('ignores a missing, false or broken legacy flag, without renaming host.json', () => {
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(false);
    writeHostFile(JSON.stringify({ version: 1, last: null, trayNoticeShown: false }));
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(false);
    writeHostFile('{"version":1,');
    expect(SettingsStore.load(dir.path, 'en').trayNoticeShown()).toBe(false);
    expect(readFileSync(hostFile(), 'utf8')).toBe('{"version":1,');
  });
});

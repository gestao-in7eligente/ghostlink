import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../src/shared/updates.js';
import { checkFailed, lastCheckedText, updatePageModel } from '../../src/renderer/features/updates/updatePage.js';
import { translate, type Translate } from '../../src/renderer/i18n/index.js';

const base: UpdateState = { status: 'idle', autoCheck: true, currentVersion: '0.2.2', version: null, percent: null, lastCheckedAt: null };
const at = (patch: Partial<UpdateState>): UpdateState => ({ ...base, ...patch });
const pt: Translate = (key, vars) => translate('pt-BR', key, vars);
const en: Translate = (key, vars) => translate('en', key, vars);

describe('updatePageModel: what the Updates page shows', () => {
  it('explains development builds and offers no check there', () => {
    expect(updatePageModel(at({ status: 'unsupported' }))).toEqual({ status: { kind: 'unsupported' }, showCheck: false, canCheck: false, newVersion: null });
  });

  it('before any answer: "Nenhuma atualização pendente", or automatic checks off', () => {
    expect(updatePageModel(base)).toEqual({ status: { kind: 'idle' }, showCheck: true, canCheck: true, newVersion: null });
    expect(updatePageModel(at({ status: 'disabled', autoCheck: false })).status).toEqual({ kind: 'disabled' });
  });

  it('"Você está na versão mais recente" once a check answered, also with automatic checks off', () => {
    expect(updatePageModel(at({ lastCheckedAt: 1_000 }))).toEqual({ status: { kind: 'upToDate', checkedAt: 1_000 }, showCheck: true, canCheck: true, newVersion: null });
    expect(updatePageModel(at({ status: 'disabled', autoCheck: false, lastCheckedAt: 1_000 })).status).toEqual({ kind: 'upToDate', checkedAt: 1_000 });
  });

  it('says so when the person\'s check got no answer', () => {
    expect(updatePageModel(at({ lastCheckedAt: 1_000 }), true)).toMatchObject({ status: { kind: 'checkFailed' }, canCheck: true });
  });

  it('"Procurando…": no second check meanwhile', () => {
    expect(updatePageModel(at({ status: 'checking' }))).toEqual({ status: { kind: 'checking' }, showCheck: true, canCheck: false, newVersion: null });
  });

  it('"Baixando a 0.2.3… 42%", with what changes in it', () => {
    expect(updatePageModel(at({ status: 'downloading', version: '0.2.3', percent: 42 }))).toEqual({
      status: { kind: 'downloading', version: '0.2.3', percent: 42 },
      showCheck: true,
      canCheck: false,
      newVersion: '0.2.3',
    });
    expect(updatePageModel(at({ status: 'downloading', version: '0.2.3', percent: null })).status).toMatchObject({ percent: 0 });
    expect(updatePageModel(at({ status: 'downloading', version: '0.2.3', percent: 140 })).status).toMatchObject({ percent: 100 });
  });

  it('"Atualizar e reiniciar" once downloaded, with what changes in it', () => {
    expect(updatePageModel(at({ status: 'downloaded', version: '0.2.3' }))).toEqual({
      status: { kind: 'downloaded', version: '0.2.3' },
      showCheck: true,
      canCheck: false,
      newVersion: '0.2.3',
    });
  });

  it('a rejected download shows the signature notice, no notes, and may be checked again', () => {
    expect(updatePageModel(at({ status: 'rejected', version: '0.2.3' }))).toEqual({ status: { kind: 'rejected', version: '0.2.3' }, showCheck: true, canCheck: true, newVersion: null });
  });

  it('never asks for notes without a valid found version', () => {
    expect(updatePageModel(at({ status: 'downloading', version: null, percent: 3 }))).toMatchObject({ status: { kind: 'downloading', version: '?' }, newVersion: null });
  });
});

describe('checkFailed: did "Procurar atualizações" get an answer?', () => {
  it('no when a newer answer came, or when it found an update', () => {
    expect(checkFailed(at({ lastCheckedAt: 1_000 }), at({ lastCheckedAt: 2_000 }))).toBe(false);
    expect(checkFailed(base, at({ lastCheckedAt: 2_000 }))).toBe(false);
    expect(checkFailed(base, at({ status: 'downloading', version: '0.2.3', percent: 0, lastCheckedAt: 2_000 }))).toBe(false);
    expect(checkFailed(base, at({ status: 'rejected', version: '0.2.3' }))).toBe(false);
  });

  it('yes when it ended at rest with no newer answer', () => {
    expect(checkFailed(base, base)).toBe(true);
    expect(checkFailed(at({ lastCheckedAt: 1_000 }), at({ lastCheckedAt: 1_000 }))).toBe(true);
    expect(checkFailed(at({ status: 'disabled' }), at({ status: 'disabled' }))).toBe(true);
  });
});

describe('lastCheckedText', () => {
  const now = new Date(2026, 9, 1, 18, 30).getTime();

  it('gives the time for a check today', () => {
    expect(lastCheckedText(pt, 'pt-BR', new Date(2026, 9, 1, 14, 2).getTime(), now)).toBe('Última verificação: hoje, às 14:02.');
    expect(lastCheckedText(en, 'en', new Date(2026, 9, 1, 14, 2).getTime(), now)).toBe('Last checked: today at 2:02 PM.');
  });

  it('adds the date for an older one', () => {
    expect(lastCheckedText(pt, 'pt-BR', new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe('Última verificação: 30/09/2026, às 09:05.');
    expect(lastCheckedText(en, 'en', new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe('Last checked: 09/30/2026 at 9:05 AM.');
  });
});

describe('Updates page texts', () => {
  it('use the wording of the request in pt-BR and exist in English', () => {
    expect(pt('updates.status.checking')).toBe('Procurando atualizações…');
    expect(pt('updates.page.checking')).toBe('Procurando…');
    expect(pt('updates.status.upToDate')).toBe('Você está na versão mais recente.');
    expect(pt('updates.status.downloading', { version: '0.2.3', percent: 42 })).toBe('Baixando a 0.2.3… 42%');
    expect(pt('updates.page.restart')).toBe('Atualizar e reiniciar');
    expect(pt('updates.page.newNotes', { version: '0.2.3' })).toBe('O que muda na 0.2.3');
    expect(pt('updates.page.installedNotes', { version: '0.2.2' })).toBe('O que mudou na sua versão (0.2.2)');
    expect(en('updates.page.restart')).toBe('Update and restart');
  });
});

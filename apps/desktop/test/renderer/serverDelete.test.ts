import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';
import { deletionReducer, initialDeletion } from '../../src/renderer/features/serverDelete/deletionStore.js';
import {
  confirmsServerName,
  deletionBanner,
  deletionCountdown,
  deletionMessage,
  exitDialogStep,
  exitMenuItem,
  offersRemoveOnly,
  welcomeDeletingAt,
} from '../../src/renderer/features/serverDelete/serverDeleteModel.js';
import { CATALOGS, translate } from '../../src/renderer/i18n/index.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 1, 15, 0);

describe('the menus (leave/delete spec §2, §3, §5)', () => {
  it('the owner sees "Excluir servidor", a member "Sair do servidor"', () => {
    expect(exitMenuItem({ connected: true, owner: true, canDelete: true })).toBe('delete');
    expect(exitMenuItem({ connected: true, owner: false, canDelete: true })).toBe('leave');
    expect(exitMenuItem({ connected: true, owner: false, canDelete: false })).toBe('leave');
  });

  it('the owner of an old server (no serverDelete) sees neither: never "Sair"', () => {
    expect(exitMenuItem({ connected: true, owner: true, canDelete: false })).toBeNull();
  });

  it('a server that is not open offers "Sair" (its dialog connects and switches to delete for the owner)', () => {
    expect(exitMenuItem({ connected: false, owner: false, canDelete: false })).toBe('leave');
    expect(exitDialogStep({ kind: 'owner', name: 'Tropa do ADS', canDelete: true, deletingAt: null })).toEqual({ step: 'delete', name: 'Tropa do ADS' });
    expect(exitDialogStep({ kind: 'member' })).toEqual({ step: 'leave' });
  });

  it('nobody sees "Remover da lista": the texts and the menus are gone', () => {
    for (const catalog of Object.values(CATALOGS)) {
      const texts = Object.entries(catalog);
      expect(texts.filter(([key]) => key.startsWith('home.remove') || key.startsWith('servers.remove'))).toEqual([]);
      expect(texts.filter(([, text]) => /remover da lista|remove from the list/i.test(text))).toEqual([]);
    }
    const sources = (root: string): string[] =>
      readdirSync(root).flatMap((name) => {
        const path = join(root, name);
        return statSync(path).isDirectory() ? sources(path) : path.endsWith('.tsx') ? [path] : [];
      });
    for (const file of sources(join(__dirname, '../../src/renderer'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/home\.remove/);
  });
});

describe('the delete modal: only the exact name unlocks it (spec §3)', () => {
  it('needs the very same name', () => {
    expect(confirmsServerName('Tropa do ADS', 'Tropa do ADS')).toBe(true);
    expect(confirmsServerName('tropa do ads', 'Tropa do ADS')).toBe(false);
    expect(confirmsServerName('Tropa do AD', 'Tropa do ADS')).toBe(false);
    expect(confirmsServerName('Tropa  do ADS', 'Tropa do ADS')).toBe(false);
    expect(confirmsServerName('', 'Tropa do ADS')).toBe(false);
    expect(confirmsServerName('Casa do Ze', 'Casa do Zé')).toBe(false);
  });

  it('forgives only the spaces around it, and composed accents', () => {
    expect(confirmsServerName('  Tropa do ADS ', 'Tropa do ADS')).toBe(true);
    expect(confirmsServerName('Casa do Zé', 'Casa do Zé')).toBe(true);
  });

  it('never unlocks for a server without a name', () => {
    expect(confirmsServerName('', '')).toBe(false);
    expect(confirmsServerName(' ', ' ')).toBe(false);
  });
});

describe("the owner's band (spec §3)", () => {
  const pt = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate('pt-BR', key, vars);

  it('says when the server goes, in whole hours, then minutes', () => {
    const banner = deletionBanner({ owner: true, deletingAt: NOW + 47 * HOUR + 59 * 60_000, name: 'Tropa do ADS', now: NOW })!;
    expect(pt('serverDelete.banner', { name: banner.name, time: pt(banner.countdown.key, banner.countdown.vars) })).toBe(
      'Tropa do ADS está fora do ar e será excluído em 47 h.',
    );
    expect(deletionCountdown(NOW + 35 * 60_000, NOW)).toEqual({ key: 'serverDelete.inMinutes', vars: { count: 35 } });
    expect(deletionCountdown(NOW + 10_000, NOW)).toEqual({ key: 'serverDelete.inMoments', vars: {} });
    expect(deletionCountdown(NOW - HOUR, NOW)).toEqual({ key: 'serverDelete.inMoments', vars: {} });
  });

  it('only the owner sees it, and only while the server is being deleted', () => {
    expect(deletionBanner({ owner: false, deletingAt: NOW + HOUR, name: 'x', now: NOW })).toBeNull();
    expect(deletionBanner({ owner: true, deletingAt: null, name: 'x', now: NOW })).toBeNull();
  });

  it('follows the welcome and the server.deleting / server.restored events of the open server', () => {
    const welcome = (deletingAt: number | null | undefined) =>
      ({ serverId: 's1', ...(deletingAt === undefined ? {} : { serverDelete: { deletingAt } }) }) as unknown as RendererWelcome;
    let s = deletionReducer(initialDeletion, { type: 'welcome', welcome: welcome(undefined) });
    expect(s).toEqual({ serverId: 's1', deletingAt: null });
    s = deletionReducer(s, { type: 'event', serverId: 's1', event: { t: 'server.deleting', d: { at: NOW + 48 * HOUR } } });
    expect(s.deletingAt).toBe(NOW + 48 * HOUR);
    expect(deletionReducer(s, { type: 'event', serverId: 's2', event: { t: 'server.restored', d: {} } })).toBe(s);
    expect(deletionReducer(s, { type: 'event', serverId: 's1', event: { t: 'server.deleting', d: { at: 'soon' } } })).toBe(s);
    expect(deletionReducer(s, { type: 'event', serverId: 's1', event: { t: 'server.restored', d: {} } }).deletingAt).toBeNull();
    expect(deletionReducer(initialDeletion, { type: 'welcome', welcome: welcome(NOW + HOUR) }).deletingAt).toBe(NOW + HOUR);
    expect(welcomeDeletingAt({ serverDelete: { deletingAt: 'x' } })).toBeNull();
  });
});

describe("the members' messages (spec §3)", () => {
  const at = Date.UTC(2026, 9, 3, 18, 40);

  it('disconnected or refused with SERVER_DELETING: who, and the date', () => {
    const message = deletionMessage('SERVER_DELETING', 'Tropa do ADS', at, 'pt-BR')!;
    expect(message.title).toBe('serverDelete.lostTitle');
    const text = translate('pt-BR', message.text, message.vars);
    expect(text).toMatch(/^Tropa do ADS foi desligado pelo dono e será excluído em .*2026.*\.$/);
    expect(text).toContain(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)));
    expect(translate('en', 'serverDelete.deleting', deletionMessage('SERVER_DELETING', 'Tropa', at, 'en')!.vars)).toMatch(/^Tropa was shut down by its owner and will be deleted on /);
  });

  it('without a date it still says what happened', () => {
    const message = deletionMessage('SERVER_DELETING', 'Tropa do ADS', null, 'pt-BR')!;
    expect(translate('pt-BR', message.text, message.vars)).toBe('Tropa do ADS foi desligado pelo dono e será excluído em breve.');
  });

  it('SERVER_DELETED: "{servidor} foi excluído pelo dono"', () => {
    const message = deletionMessage('SERVER_DELETED', 'Tropa do ADS', null, 'pt-BR')!;
    expect(translate('pt-BR', message.title)).toBe('Servidor excluído');
    expect(translate('pt-BR', message.text, message.vars)).toBe('Tropa do ADS foi excluído pelo dono.');
  });

  it('any other failure keeps its usual text', () => {
    expect(deletionMessage('KICKED', 'x', null, 'pt-BR')).toBeNull();
    expect(deletionMessage(null, 'x', null, 'pt-BR')).toBeNull();
  });
});

describe('"Sair do servidor" on a server that is not open', () => {
  it('maps what the app found to the dialog to show', () => {
    expect(exitDialogStep(null)).toEqual({ step: 'checking' });
    expect(exitDialogStep({ kind: 'owner', name: 'x', canDelete: false, deletingAt: null })).toEqual({ step: 'ownerCannot' });
    expect(exitDialogStep({ kind: 'owner', name: 'x', canDelete: true, deletingAt: NOW })).toEqual({ step: 'ownerDeleting', at: NOW });
    expect(exitDialogStep({ kind: 'deleting', at: NOW })).toEqual({ step: 'deleting', at: NOW });
    expect(exitDialogStep({ kind: 'deleted' })).toEqual({ step: 'deleted' });
    expect(exitDialogStep({ kind: 'unreachable', code: 'UNREACHABLE' })).toEqual({ step: 'unreachable', code: 'UNREACHABLE' });
  });

  it('offers "Tirar só da minha lista" when the server cannot be reached, not when it refused the request', () => {
    for (const code of ['UNREACHABLE', 'TIMEOUT', 'CONNECTION_LOST', 'SERVER_DELETING', 'SERVER_DELETED', 'INVITE_REQUIRED', 'BANNED'] as const) expect(offersRemoveOnly(code), code).toBe(true);
    for (const code of ['RATE_LIMITED', 'OWNER_MUST_TRANSFER', 'FORBIDDEN', 'INTERNAL'] as const) expect(offersRemoveOnly(code), code).toBe(false);
  });
});

// The server rail and its "Adicionar servidor" chooser, as the owner's UI reference
// asks (ui-reference.md, 2026-09-28): "+" right below home, opening a modal with
// "Criar um servidor" (Hosting's flow) and "Entrar em um servidor" (the Join flow).
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import { translate } from '../../src/renderer/i18n/index.js';
import { addServerActions, railEntries } from '../../src/renderer/layout/rail.js';
import { registerLayoutSlots, resetLayoutSlots, useLayoutSlots } from '../../src/renderer/layout/slots.js';

afterEach(() => resetLayoutSlots());

const saved = (id: string): SavedServer => ({ id, name: `Servidor ${id}`, serverKeyId: 'k'.repeat(43), addresses: ['127.0.0.1:7777'], nickname: 'Eu', addedAt: 1 });

describe('server rail (owner UI reference)', () => {
  it('puts the round "+" right below home, then the divider, the saved servers and the extras', () => {
    expect(railEntries([saved('a'), saved('b')]).map((e) => (e.kind === 'server' ? `server:${e.server.id}` : e.kind))).toEqual([
      'home',
      'add',
      'divider',
      'server:a',
      'server:b',
      'extras',
    ]);
    expect(railEntries([]).map((e) => e.kind)).toEqual(['home', 'add', 'divider', 'extras']);
  });

  it('labels the "+" and its chooser like the reference, in both languages', () => {
    expect(translate('pt-BR', 'layout.addServer')).toBe('Adicionar servidor');
    expect(translate('pt-BR', 'layout.addServer.create')).toBe('Criar um servidor');
    expect(translate('pt-BR', 'layout.addServer.createHint')).toBe('Hospede no seu computador; você será o dono');
    expect(translate('pt-BR', 'layout.addServer.join')).toBe('Entrar em um servidor');
    expect(translate('pt-BR', 'layout.addServer.joinHint')).toBe('Use um convite ou endereço');
    for (const key of ['layout.addServer', 'layout.addServer.create', 'layout.addServer.createHint', 'layout.addServer.join', 'layout.addServer.joinHint'] as const) {
      expect(translate('en', key)).not.toBe('');
      expect(translate('en', key)).not.toBe(translate('pt-BR', key));
    }
  });
});

describe('"Adicionar servidor" chooser', () => {
  it('create opens the Hosting flow and join the Join flow once registered; the server list until then', () => {
    const calls: string[] = [];
    const home = () => calls.push('home');
    let actions = addServerActions(useLayoutSlots.getState(), home);
    actions.create();
    actions.join();
    expect(calls).toEqual(['home', 'home']);
    registerLayoutSlots({ onCreateServer: () => calls.push('host'), onJoinServer: () => calls.push('join') });
    actions = addServerActions(useLayoutSlots.getState(), home);
    actions.create();
    actions.join();
    expect(calls).toEqual(['home', 'home', 'host', 'join']);
  });
});

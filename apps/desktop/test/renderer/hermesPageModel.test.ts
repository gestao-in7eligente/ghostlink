import { describe, expect, it } from 'vitest';
import { HERMES_DEFAULT_SETTINGS, type Channel, type HermesView, type Role } from '@ghostlink/shared';
import { filterSkills, hermesPageBlocks, hermesPageTabs, pageSkillRows, searchSkills, type SkillRow } from '../../src/renderer/features/bots/hermes/hermesPageModel.js';
import { enterpriseReducer, initialEnterprise } from '../../src/renderer/stores/enterprise.js';
import type { RendererWelcome } from '../../src/shared/ipcTypes.js';

const role = (id: string, name: string, position: number): Role => ({ id, name, color: 0, permissions: 0, position, hoist: false, mentionable: false, isDefault: position === 0 });
const channel = (id: string, name: string, position: number): Channel => ({ id, name, type: 'text', topic: '', position, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0 });
const known = {
  roles: { e: role('e', '@todos', 0), d: role('d', 'Diretoria', 2), v: role('v', 'Vendas', 1) },
  channels: { g: channel('g', 'geral', 0), s: channel('s', 'suporte', 1) },
};
const view = (o: Partial<HermesView> = {}): HermesView => ({
  botId: 'b'.repeat(32),
  connected: true,
  models: HERMES_DEFAULT_SETTINGS.models,
  modelInUse: null,
  skills: null,
  access: { roleIds: [], channels: 'all' },
  hiddenChannels: 0,
  ...o,
});

describe('the company Hermes page blocks (spec 2026-10-03 §2)', () => {
  it('without a report: no skills, no model in use, no memory yet', () => {
    const b = hermesPageBlocks(view({ connected: false, memory: null }), known);
    expect(b).toMatchObject({ connected: false, primary: 'DeepSeek · deepseek-v4-pro', fallback: 'OpenRouter · deepseek/deepseek-v4-pro', inUse: null, skills: null, memory: null });
  });

  it('with and without a fallback; the model in use only when it is not the primary', () => {
    const models = { primary: { provider: 'deepseek' as const, model: 'deepseek-v4-pro' }, fallback: null };
    expect(hermesPageBlocks(view({ models, modelInUse: { provider: 'deepseek', model: 'deepseek-v4-pro' } }), known)).toMatchObject({ fallback: null, inUse: null });
    expect(hermesPageBlocks(view({ modelInUse: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' } }), known).inUse).toBe('OpenRouter · deepseek/deepseek-v4-pro');
    expect(hermesPageBlocks(view({ modelInUse: { provider: 'custom', model: 'x' } }), known).inUse).toBe('custom · x');
  });

  it("channels 'all' or the names, plus the server's count of the ones this person cannot see; roles by position", () => {
    expect(hermesPageBlocks(view(), known).channels).toEqual({ all: true });
    const chosen = view({ access: { roleIds: ['v', 'd', 'gone'], channels: ['s', 'g'] }, hiddenChannels: 2 });
    expect(hermesPageBlocks(chosen, known)).toMatchObject({ channels: { all: false, names: ['geral', 'suporte'], hidden: 2 }, roles: ['Diretoria', 'Vendas'] });
    expect(hermesPageBlocks(view({ access: { roleIds: [], channels: ['g', 'unknown'] } }), known).channels).toEqual({ all: false, names: ['geral'], hidden: 0 });
  });

  it("the role's page has no memory block; the owner's has the counts", () => {
    expect(hermesPageBlocks(view(), known).memory).toBeUndefined();
    expect(hermesPageBlocks(view({ memory: { company: 3, people: 1 } }), known).memory).toEqual({ company: 3, people: 1 });
  });

  it('the store takes the page from the welcome and the hermes.view event, and drops it on view: null', () => {
    const welcome = { serverId: 's1', hermesView: view() } as unknown as RendererWelcome;
    let s = enterpriseReducer(initialEnterprise, { type: 'welcome', welcome });
    expect(s.view?.botId).toBe('b'.repeat(32));
    s = enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'hermes.view', d: { view: view({ connected: false }) } } });
    expect(s.view?.connected).toBe(false);
    expect(enterpriseReducer(s, { type: 'event', serverId: 's2', envelope: { t: 'hermes.view', d: { view: null } } })).toBe(s);
    expect(enterpriseReducer(s, { type: 'event', serverId: 's1', envelope: { t: 'hermes.view', d: { view: null } } }).view).toBeNull();
    expect(enterpriseReducer(initialEnterprise, { type: 'welcome', welcome: { serverId: 's1' } as unknown as RendererWelcome }).view).toBeNull();
  });
});

describe('the company Hermes page tabs (spec 2026-10-03 pagina larga e abas)', () => {
  const rows: SkillRow[] = [
    { name: 'git-flow', description: 'Fluxo de ramificação', enabled: true },
    { name: 'planejamento', description: 'Organiza as TAREFAS', enabled: false },
    { name: 'ocr', description: '', enabled: true },
  ];

  it('the owner sees five tabs; the role holder has no Memória', () => {
    expect(hermesPageTabs(true)).toEqual(['overview', 'skills', 'access', 'memory', 'commands']);
    expect(hermesPageTabs(false)).toEqual(['overview', 'skills', 'access', 'commands']);
  });

  it('searches name and description, ignoring case and accents', () => {
    expect(searchSkills(rows, '').length).toBe(3);
    expect(searchSkills(rows, '  ').length).toBe(3);
    expect(searchSkills(rows, 'RAMIFICACAO').map((r) => r.name)).toEqual(['git-flow']);
    expect(searchSkills(rows, 'tarefas').map((r) => r.name)).toEqual(['planejamento']);
    expect(searchSkills(rows, 'GIT').map((r) => r.name)).toEqual(['git-flow']);
    expect(searchSkills(rows, 'nada')).toEqual([]);
  });

  it('the Ligadas filter hides the off ones; Todas keeps them; both combine with the search', () => {
    expect(filterSkills(rows, 'on', '').map((r) => r.name)).toEqual(['git-flow', 'ocr']);
    expect(filterSkills(rows, 'all', '').length).toBe(3);
    expect(filterSkills(rows, 'on', 'tarefas')).toEqual([]);
    expect(filterSkills(rows, 'all', 'tarefas').map((r) => r.name)).toEqual(['planejamento']);
  });

  it("the owner's rows come from the full state (with the off ones); the role's from the page", () => {
    const v = view({ skills: [{ name: 'a', description: 'x' }] });
    expect(pageSkillRows(v, null)).toEqual([{ name: 'a', description: 'x', enabled: true }]);
    expect(pageSkillRows(view(), null)).toBeNull();
    const state = {
      settings: { disabledSkills: ['b'] },
      report: { skills: [{ name: 'a', description: 'x', enabled: true, locked: false }, { name: 'b', description: 'y', enabled: true, locked: false }] },
    } as unknown as Parameters<typeof pageSkillRows>[1];
    expect(pageSkillRows(v, state)).toEqual([
      { name: 'a', description: 'x', enabled: true },
      { name: 'b', description: 'y', enabled: false },
    ]);
  });
});

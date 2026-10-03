// The company Hermes's page (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md §2): the blocks
// shown on the bot's page, built from the server's view and the roles and channels this app knows.
import type { Channel, HermesModelInUse, HermesProvider, HermesState, HermesView, HermesViewSkill, Role } from '@ghostlink/shared';
import { sortedChannels } from '../../../stores/channels.js';
import { rolesByPosition } from '../../../stores/server.js';
import { PROVIDER_NAMES, skillEnabled } from './hermesModel.js';

export interface HermesPageBlocks {
  /** 1. Situação e modelo. "Provedor · modelo". */
  connected: boolean;
  primary: string;
  /** null: "Sem reserva". */
  fallback: string | null;
  /** What the Hermes said it uses, only when it is not the configured primary. */
  inUse: string | null;
  /** 2. Skills: the ones on; null: the Hermes never reported. */
  skills: HermesViewSkill[] | null;
  /** 3. Onde e quem usa: every channel, or the names plus how many this person cannot see (the server's count). */
  channels: { all: true } | { all: false; names: string[]; hidden: number };
  /** The roles that may talk to it, strongest first (the page adds "o dono"). */
  roles: string[];
  /** 4. Memória: the owner's only (undefined for the role); null before a report. */
  memory: { company: number; people: number } | null | undefined;
}

/** "DeepSeek · deepseek-v4-pro"; a provider GhostLink does not manage keeps its own name. */
export function modelLabel(m: HermesModelInUse): string {
  const provider = Object.hasOwn(PROVIDER_NAMES, m.provider) ? PROVIDER_NAMES[m.provider as HermesProvider] : m.provider;
  return `${provider} · ${m.model}`;
}

export function hermesPageBlocks(view: HermesView, known: { roles: Readonly<Record<string, Role>>; channels: Readonly<Record<string, Channel>> }): HermesPageBlocks {
  const { primary, fallback } = view.models;
  const inUse = view.modelInUse;
  const sameAsPrimary = inUse !== null && inUse.provider === primary.provider && inUse.model === primary.model;
  const { channels, roleIds } = view.access;
  let where: HermesPageBlocks['channels'] = { all: true };
  if (channels !== 'all') {
    const names = sortedChannels(known.channels, 'text').filter((c) => channels.includes(c.id)).map((c) => c.name);
    // The server names only the channels this person can see and counts the rest.
    where = { all: false, names, hidden: view.hiddenChannels };
  }
  return {
    connected: view.connected,
    primary: modelLabel(primary),
    fallback: fallback === null ? null : modelLabel(fallback),
    inUse: inUse === null || sameAsPrimary ? null : modelLabel(inUse),
    skills: view.skills,
    channels: where,
    roles: rolesByPosition(known.roles).filter((r) => !r.isDefault && roleIds.includes(r.id)).map((r) => r.name),
    memory: view.memory,
  };
}

export type HermesPageTab = 'overview' | 'skills' | 'access' | 'memory' | 'commands';

/** The tabs under the badge: Memória is the owner's only. */
export function hermesPageTabs(owner: boolean): HermesPageTab[] {
  return owner ? ['overview', 'skills', 'access', 'memory', 'commands'] : ['overview', 'skills', 'access', 'commands'];
}

export interface SkillRow {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * The Skills tab's rows. The owner has the full state, so the off ones show too; everyone else has
 * the ones on. null: the Hermes never reported.
 */
export function pageSkillRows(view: HermesView, state: HermesState | null): SkillRow[] | null {
  if (state !== null && state.report !== null) {
    return state.report.skills.map((s) => ({ name: s.name, description: s.description, enabled: skillEnabled(state, s) }));
  }
  return view.skills === null ? null : view.skills.map((s) => ({ name: s.name, description: s.description, enabled: true }));
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Name and description, ignoring case and accents; an empty search keeps everything. */
export function searchSkills(rows: readonly SkillRow[], query: string): SkillRow[] {
  const q = fold(query.trim());
  if (q === '') return [...rows];
  return rows.filter((r) => fold(r.name).includes(q) || fold(r.description).includes(q));
}

export type SkillFilter = 'on' | 'all';

/** "Ligadas | Todas" (the owner's), then the search. */
export function filterSkills(rows: readonly SkillRow[], filter: SkillFilter, query: string): SkillRow[] {
  return searchSkills(filter === 'on' ? rows.filter((r) => r.enabled) : rows, query);
}

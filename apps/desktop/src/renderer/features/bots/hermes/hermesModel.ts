import { HERMES_PROVIDERS, HERMES_PROVIDER_NAMES, type Edition, type HermesModelRef, type HermesProvider, type HermesSettings, type HermesSkill, type HermesState } from '@ghostlink/shared';
import type { MessageKey, Vars } from '../../../i18n/index.js';

export const PROVIDER_NAMES: Record<HermesProvider, string> = HERMES_PROVIDER_NAMES;

/** Providers the owner may pick models from (spec §2 "Modelos"): the ones with a key saved. */
export function providersWithKeys(state: HermesState): HermesProvider[] {
  return HERMES_PROVIDERS.filter((p) => state.keys[p] !== null);
}

/** The server's list once it has one; before that, what the Hermes reported. */
function disabledNow(state: HermesState): string[] {
  return state.settings.disabledSkills ?? state.report?.skills.filter((s) => !s.enabled && !s.locked).map((s) => s.name) ?? [];
}

export function skillEnabled(state: HermesState, skill: HermesSkill): boolean {
  return skill.locked || !disabledNow(state).includes(skill.name);
}

/** The whole disabled list after switching one skill (what hermes.update sends). */
export function toggledSkills(state: HermesState, name: string, enabled: boolean): string[] {
  const set = new Set(disabledNow(state));
  if (enabled) set.delete(name);
  else set.add(name);
  return [...set].sort();
}

export interface HermesLine {
  key: MessageKey;
  vars?: Vars;
  tone: 'ok' | 'warn' | 'error';
}

/** "Situação" (spec §2): the most important first. */
export function statusLines(state: HermesState): HermesLine[] {
  const lines: HermesLine[] = [];
  const r = state.report;
  if (state.locked) lines.push({ key: 'hermes.status.locked', tone: 'error' });
  lines.push(state.connected ? { key: 'hermes.status.connected', tone: 'ok' } : { key: 'hermes.status.disconnected', tone: 'warn' });
  if (r?.status.unsupported) lines.push({ key: 'hermes.status.unsupported', tone: 'error' });
  if (state.connected && r !== null && r.appliedVersion < state.version) lines.push({ key: 'hermes.status.applying', tone: 'warn' });
  if (r?.status.model) lines.push({ key: 'hermes.status.model', vars: { model: r.status.model.model }, tone: 'ok' });
  for (const p of HERMES_PROVIDERS) {
    const k = r?.status.keys[p];
    if (k === 'refused') lines.push({ key: 'hermes.status.keyRefused', vars: { provider: PROVIDER_NAMES[p] }, tone: 'error' });
    if (k === 'unreachable') lines.push({ key: 'hermes.status.keyUnreachable', vars: { provider: PROVIDER_NAMES[p] }, tone: 'warn' });
  }
  for (const p of r?.status.envOverride ?? []) lines.push({ key: 'hermes.status.envOverride', vars: { provider: PROVIDER_NAMES[p] }, tone: 'warn' });
  return lines;
}

/** "Hermes da empresa" in "Adicionar bot" (spec §2 "Criar"). `hermes` is null on servers without it. */
export function canCreateCompanyHermes(o: { owner: boolean; edition: Edition; hermes: HermesState | null }): boolean {
  return o.owner && o.edition === 'enterprise' && o.hermes !== null && o.hermes.botId === null;
}

/** The Models tab's starting point (spec §2: only providers with a key): a model whose provider has none is replaced. */
export function initialModels(state: HermesState): HermesSettings['models'] {
  const providers = providersWithKeys(state);
  const { primary, fallback } = state.settings.models;
  return {
    primary: providers.includes(primary.provider) ? primary : { provider: providers[0] ?? primary.provider, model: '' },
    fallback: fallback && providers.includes(fallback.provider) ? fallback : null,
  };
}

/** "Salvar modelos" is allowed only with every chosen provider among those with a key, and a model id each. */
export function modelsSaveable(providers: readonly HermesProvider[], primary: HermesModelRef, fallback: HermesModelRef | null): boolean {
  const ok = (m: HermesModelRef) => providers.includes(m.provider) && m.model.trim() !== '';
  return ok(primary) && (fallback === null || ok(fallback));
}

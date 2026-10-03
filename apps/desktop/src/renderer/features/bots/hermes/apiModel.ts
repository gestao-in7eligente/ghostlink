// The API tab of the company Hermes's page (spec 2026-10-03-aba-api-e-sites-design.md §1): its rows and
// checks, from the owner's HermesState. No React and no stores, so the tests load it.
import {
  HERMES_API_CATALOG,
  HERMES_LIMITS,
  HERMES_PROVIDERS_V1,
  apiEnvVarProblem,
  type HermesKeyStatus,
  type HermesProvider,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';

export type ApiGroup = 'ai' | 'other' | 'custom';

export interface ApiRow {
  envVar: string;
  name: string;
  group: ApiGroup;
  /** The AI provider; null for the other APIs. */
  provider: HermesProvider | null;
  /** The saved key's last 4; null: "não configurada". */
  last4: string | null;
  /** An AI's key test as the Hermes reported it ("ok" / "recusada" / "sem resposta"); null: none to show. */
  test: 'ok' | 'refused' | 'unreachable' | null;
}

const shownTest = (status: HermesKeyStatus | undefined): ApiRow['test'] =>
  status === 'ok' || status === 'refused' || status === 'unreachable' ? status : null;

/**
 * The rows: the catalog's AIs, its other APIs, then the owner's own by name. `full`: the server has
 * `enterpriseApis`; before it, DeepSeek and OpenRouter only (plan decision 7).
 */
export function apiRows(state: HermesState, full: boolean): ApiRow[] {
  const v1: readonly string[] = HERMES_PROVIDERS_V1;
  const rows: ApiRow[] = HERMES_API_CATALOG.filter((a) => full || (a.provider !== null && v1.includes(a.provider))).map((a) => {
    const last4 = a.provider !== null ? (state.keys[a.provider]?.last4 ?? null) : (state.apis.find((x) => x.envVar === a.envVar)?.last4 ?? null);
    return {
      envVar: a.envVar,
      name: a.name,
      group: a.provider !== null ? 'ai' : 'other',
      provider: a.provider,
      last4,
      test: a.provider !== null && last4 !== null ? shownTest(state.report?.status.keys[a.provider]) : null,
    };
  });
  if (!full) return rows;
  const own = state.apis
    .filter((x) => !HERMES_API_CATALOG.some((a) => a.envVar === x.envVar))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.envVar.localeCompare(b.envVar));
  return [...rows, ...own.map((x): ApiRow => ({ envVar: x.envVar, name: x.name, group: 'custom', provider: null, last4: x.last4, test: null }))];
}

/** Keys saved in all (the limit of 30 counts the AIs' too). */
export function savedKeys(state: HermesState): number {
  return Object.values(state.keys).filter((k) => k !== null).length + state.apis.length;
}

export type OtherApiProblem = 'name' | 'format' | 'suffix' | 'reserved' | 'catalog' | 'taken' | 'key' | 'limit';

/** "Outra API": what is wrong before it is sent, or null. */
export function otherApiProblem(state: HermesState, f: { name: string; envVar: string; key: string }): OtherApiProblem | null {
  if (f.name.trim() === '') return 'name';
  const problem = apiEnvVarProblem(f.envVar);
  if (problem !== null) return problem;
  if (state.apis.some((a) => a.envVar === f.envVar)) return 'taken';
  if (!/^[\x21-\x7e]{8,512}$/.test(f.key.trim())) return 'key';
  if (savedKeys(state) >= HERMES_LIMITS.maxApis) return 'limit';
  return null;
}

/** The hermes.update that saves a row's key (`null` deletes it). */
export function apiPatch(row: Pick<ApiRow, 'envVar' | 'provider'>, key: string | null): HermesUpdatePayload {
  const value = key === null ? null : key.trim();
  if (row.provider !== null) return { keys: { [row.provider]: value } };
  return { apis: { [row.envVar]: value === null ? null : { value } } };
}

/** The hermes.update that adds "Outra API". */
export function newApiPatch(f: { name: string; envVar: string; key: string }): HermesUpdatePayload {
  return { apis: { [f.envVar]: { name: f.name.trim(), value: f.key.trim() } } };
}

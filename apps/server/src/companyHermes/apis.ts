import {
  HERMES_API_CATALOG,
  HERMES_LIMITS,
  HERMES_PROVIDERS,
  HERMES_PROVIDER_ENV,
  ProtocolError,
  apiEnvVarProblem,
  sanitizeLabel,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import type { HermesApisChange, HermesRecord } from './store.js';

/**
 * The API tab's rules (spec 2026-10-03-aba-api-e-sites-design.md §1) for one hermes.update, before
 * anything is stored: `apis` names the catalog's other APIs or a variable of the owner's own that is not
 * a system, Hermes or GhostLink one and ends in a key suffix (an AI's key goes in `keys`); a new variable
 * of the owner's needs a name; at most 30 keys in all, the AIs' included. Returns the change with each
 * name settled. BAD_REQUEST never echoes a variable or a key.
 */
export function checkApisChange(current: HermesRecord, p: Pick<HermesUpdatePayload, 'keys' | 'apis'>): HermesApisChange | undefined {
  const saved = new Set<string>([
    ...HERMES_PROVIDERS.filter((x) => current.keys[x] !== null).map((x) => HERMES_PROVIDER_ENV[x]),
    ...current.apis.map((a) => a.envVar),
  ]);
  const before = saved.size;
  for (const provider of HERMES_PROVIDERS) {
    const value = p.keys?.[provider];
    if (value === null) saved.delete(HERMES_PROVIDER_ENV[provider]);
    else if (value !== undefined) saved.add(HERMES_PROVIDER_ENV[provider]);
  }
  let out: HermesApisChange | undefined;
  if (p.apis !== undefined) {
    out = {};
    for (const [envVar, change] of Object.entries(p.apis)) {
      const problem = apiEnvVarProblem(envVar);
      if (problem === 'format' || problem === 'suffix' || problem === 'reserved') throw new ProtocolError('BAD_REQUEST', 'a reserved variable');
      const entry = HERMES_API_CATALOG.find((a) => a.envVar === envVar);
      if (entry?.provider) throw new ProtocolError('BAD_REQUEST', "an AI's key goes in keys");
      if (change === null) {
        out[envVar] = null;
        saved.delete(envVar);
        continue;
      }
      const name = entry?.name ?? sanitizeLabel(change.name ?? current.apis.find((a) => a.envVar === envVar)?.name ?? '', HERMES_LIMITS.apiNameMax);
      if (name === '') throw new ProtocolError('BAD_REQUEST', 'the API needs a name');
      out[envVar] = { name, value: change.value };
      saved.add(envVar);
    }
  }
  // Only growth is refused: a store already over the limit can still delete its way back.
  if (saved.size > HERMES_LIMITS.maxApis && saved.size > before) throw new ProtocolError('BAD_REQUEST', 'too many keys');
  return out;
}

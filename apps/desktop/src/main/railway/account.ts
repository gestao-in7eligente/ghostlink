import { toAppErrorCode } from '../../shared/appErrors.js';
import type { RailwayPlan, RailwayWorkspace } from '../../shared/railwayTypes.js';
import type { Log } from '../log.js';
import { RailwayError, type RailwayClient } from './api.js';
import { DATA, OPS } from './operations.js';

/** More workspaces than this are not listed (each costs a plan request; Free: 100 requests/hour). */
export const WORKSPACES_MAX = 20;

export function toPlan(plan: string | null | undefined, trialing = false): RailwayPlan {
  if (trialing) return 'TRIAL';
  return plan === 'FREE' || plan === 'HOBBY' || plan === 'PRO' ? plan : 'UNKNOWN';
}

/**
 * Validates the token by listing its workspaces (research §2.1): `apiToken` works for every
 * Bearer token; `me` is the fallback for account and OAuth tokens. A token that reaches no
 * workspace cannot create anything, so it counts as invalid.
 */
export async function fetchWorkspaces(api: RailwayClient, log: Log): Promise<RailwayWorkspace[]> {
  let listed: { id: string; name: string; plan?: string | null }[] = [];
  try {
    listed = (await api.request(OPS.apiToken, {}, DATA.apiToken)).apiToken.workspaces;
  } catch (e) {
    // Only an answer from Railway is worth a second question; offline or rate limited, `me` fails the same way.
    if (!(e instanceof RailwayError) || (e.code !== 'RAILWAY_TOKEN_INVALID' && e.code !== 'RAILWAY_API_ERROR')) throw e;
  }
  if (listed.length === 0) listed = (await api.request(OPS.me, {}, DATA.me)).me.workspaces;
  if (listed.length === 0) throw new RailwayError('RAILWAY_TOKEN_INVALID', 'the token reaches no workspace');
  const workspaces: RailwayWorkspace[] = [];
  for (const w of listed.slice(0, WORKSPACES_MAX)) {
    workspaces.push({ id: w.id, name: w.name, plan: await planOf(api, w, log) });
  }
  return workspaces;
}

/** Best effort: billing may need the Admin role (not verified), so any failure means UNKNOWN (or me's plan). */
async function planOf(api: RailwayClient, w: { id: string; plan?: string | null }, log: Log): Promise<RailwayPlan> {
  try {
    const { workspace } = await api.request(OPS.workspacePlan, { workspaceId: w.id }, DATA.workspacePlan);
    return toPlan(workspace.plan, workspace.customer.isTrialing);
  } catch (e) {
    log.warn(`[railway] the plan of workspace ${w.id} is unknown (${toAppErrorCode(e)})`);
    return toPlan(w.plan);
  }
}

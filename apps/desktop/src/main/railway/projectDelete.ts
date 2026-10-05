// Deleting a Railway project (research §3.3): the provisioner's "discard" and the deletion of a
// server the owner deleted (serverDeletions.ts, leave/delete spec §3) both go through here.
import type { Log } from '../log.js';
import { RailwayError, type RailwayClient } from './api.js';
import { DATA, OPS } from './operations.js';

/** Deletes the project; one that is gone already counts as deleted. Anything else throws. */
export async function deleteRailwayProject(api: RailwayClient, projectId: string, log: Log): Promise<void> {
  try {
    await api.request(OPS.projectDelete, { id: projectId }, DATA.projectDelete);
  } catch (e) {
    if (!(e instanceof RailwayError)) throw e;
    // Only a refusal from Railway can mean "already gone"; offline or rate limited, the record stays.
    const refused = e.messages.length > 0 || e.code === 'RAILWAY_TOKEN_INVALID';
    if (!refused || !(e.notFound || (await projectGone(api, projectId)))) throw e;
    log.info(`[railway] project ${projectId} was already gone`);
  }
}

/**
 * After a refused delete: true when the project no longer exists. Railway may answer "Not
 * Authorized" for an id it cannot find (not verified), so a token that still works but cannot
 * see the project means it is gone.
 */
async function projectGone(api: RailwayClient, projectId: string): Promise<boolean> {
  try {
    const { project } = await api.request(OPS.project, { id: projectId }, DATA.project);
    return project.deletedAt !== null && project.deletedAt !== undefined;
  } catch (e) {
    if (!(e instanceof RailwayError)) return false;
    if (e.notFound) return true;
    if (e.code !== 'RAILWAY_TOKEN_INVALID') return false;
    try {
      await api.request(OPS.apiToken, {}, DATA.apiToken);
      return true;
    } catch {
      return false;
    }
  }
}

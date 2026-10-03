import { z } from 'zod';
import { siteSchemaClient, type Channel, type Site } from '@ghostlink/shared';
import { request } from '../chat/actions.js';

const answer = z.object({ site: siteSchemaClient });

/** Registers a site; `channelId` null creates its channel. The server's sites.state updates the sidebar. */
export async function createSite(p: { name: string; domain: string; channelId: string | null }): Promise<Site> {
  return (await request('site.create', p, answer)).site;
}

export async function updateSite(id: string, p: { name: string; domain: string }): Promise<Site> {
  return (await request('site.update', { id, ...p }, answer)).site;
}

/** Removes the site; its channel goes back to "Canais de texto". */
export async function deleteSite(id: string): Promise<void> {
  await request('site.delete', { id }, z.object({}));
}

/**
 * "Cadastrar como sites" (plan decision 3): each channel becomes a site named and addressed after it.
 * Stops at the first refusal; `onDone` gets the count registered so far, so the dialog can report it.
 */
export async function registerChannelsAsSites(channels: readonly Channel[], onDone?: (done: number) => void): Promise<void> {
  let done = 0;
  for (const c of channels) {
    await createSite({ name: c.name, domain: c.name, channelId: c.id });
    onDone?.(++done);
  }
}

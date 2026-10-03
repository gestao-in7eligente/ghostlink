import { z } from 'zod';
import {
  botCreateResultSchemaClient,
  hermesStateSchemaClient,
  hermesViewSchemaClient,
  type BotCreateResult,
  type HermesMemoryTarget,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import { errorCodeOf } from '../../../i18n/index.js';
import { useEnterpriseStore } from '../../../stores/enterprise.js';
import { textState } from '../../../stores/text.js';
import { request } from '../../chat/actions.js';

/** A bot marked as the company Hermes; its code shows once (for GHOSTLINK_BOT on Railway). */
export function createCompanyHermes(name: string): Promise<BotCreateResult> {
  return request('hermes.create', { name: name.trim() }, botCreateResultSchemaClient);
}

/** Saves a change; the answer (and hermes.state) refresh the panel. A key passed here is never kept. */
export async function updateHermes(patch: HermesUpdatePayload): Promise<HermesState> {
  const serverId = textState().server.serverId;
  const state = await request('hermes.update', { ...patch }, hermesStateSchemaClient);
  useEnterpriseStore.getState().dispatch({ type: 'hermes', serverId, state });
  return state;
}

/** The Hermes removes the item and reports the new list (BOT_OFFLINE while it is disconnected). */
export async function deleteHermesMemory(target: HermesMemoryTarget, id: string): Promise<void> {
  await request('hermes.memory.delete', { target, id }, z.object({}));
}

/**
 * The company Hermes's page, fresh, when it opens (spec 2026-10-03; the events keep it live after).
 * FORBIDDEN: this person no longer sees it. Other errors keep what the store has.
 */
export async function refreshHermesView(): Promise<void> {
  const serverId = textState().server.serverId;
  try {
    const { view } = await request('hermes.view', {}, z.object({ view: hermesViewSchemaClient }));
    useEnterpriseStore.getState().dispatch({ type: 'view', serverId, view });
  } catch (e) {
    if (errorCodeOf(e) === 'FORBIDDEN') useEnterpriseStore.getState().dispatch({ type: 'view', serverId, view: null });
  }
}

import { z } from 'zod';
import {
  botCreateResultSchemaClient,
  hermesStateSchemaClient,
  type BotCreateResult,
  type HermesMemoryTarget,
  type HermesState,
  type HermesUpdatePayload,
} from '@ghostlink/shared';
import { useEnterpriseStore } from '../../../stores/enterprise.js';
import { request } from '../../chat/actions.js';

/** A bot marked as the company Hermes; its code shows once (for GHOSTLINK_BOT on Railway). */
export function createCompanyHermes(name: string): Promise<BotCreateResult> {
  return request('hermes.create', { name: name.trim() }, botCreateResultSchemaClient);
}

/** Saves a change; the answer (and hermes.state) refresh the panel. A key passed here is never kept. */
export async function updateHermes(patch: HermesUpdatePayload): Promise<HermesState> {
  const state = await request('hermes.update', { ...patch }, hermesStateSchemaClient);
  useEnterpriseStore.getState().dispatch({ type: 'hermes', state });
  return state;
}

/** The Hermes removes the item and reports the new list (BOT_OFFLINE while it is disconnected). */
export async function deleteHermesMemory(target: HermesMemoryTarget, id: string): Promise<void> {
  await request('hermes.memory.delete', { target, id }, z.object({}));
}

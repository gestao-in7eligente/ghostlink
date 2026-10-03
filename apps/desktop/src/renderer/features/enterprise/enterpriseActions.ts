import { enterpriseStateSchemaClient, type EnterpriseState } from '@ghostlink/shared';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { textState } from '../../stores/text.js';
import { request } from '../chat/actions.js';

/** The owner pastes a license: checked by the server at once (LICENSE_INVALID, LICENSE_EXPIRED). */
export async function setLicense(license: string): Promise<EnterpriseState> {
  const serverId = textState().server.serverId;
  const state = await request('enterprise.license.set', { license: license.trim() }, enterpriseStateSchemaClient);
  useEnterpriseStore.getState().dispatch({ type: 'enterprise', serverId, state });
  return state;
}

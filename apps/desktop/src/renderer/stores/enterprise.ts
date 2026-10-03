// Enterprise and the company Hermes as this app sees them (spec 2026-10-02-enterprise-e-hermes-da-empresa
// §1, §2): the edition of the server on screen (everyone), its license and the company Hermes's state
// (the owner only). Seeded by the welcome's `enterprise` and `hermes` keys, then kept by the
// `enterprise.state` and `hermes.state` events and by the answers to the owner's own requests.
// A server before 0.6.0 sends none of them: normal.
import { useLayoutEffect } from 'react';
import { create } from 'zustand';
import {
  enterpriseStateSchemaClient,
  hermesStateSchemaClient,
  type Edition,
  type EnterpriseLicenseInfo,
  type EnterpriseState,
  type Envelope,
  type HermesState,
} from '@ghostlink/shared';
import type { GhostlinkApi, RendererWelcome } from '../../shared/ipcTypes.js';
import { useConnectionStore } from './connection.js';

export interface EnterpriseView {
  serverId: string | null;
  edition: Edition;
  /** The owner only; null: none pasted, or not the owner. */
  license: EnterpriseLicenseInfo | null;
  /** The owner only, on servers with the company Hermes. */
  hermes: HermesState | null;
}

export type EnterpriseAction =
  | { type: 'welcome'; welcome: RendererWelcome }
  | { type: 'event'; serverId: string; envelope: Envelope }
  | { type: 'enterprise'; serverId: string | null; state: EnterpriseState }
  | { type: 'hermes'; serverId: string | null; state: HermesState }
  | { type: 'left' };

export const initialEnterprise: EnterpriseView = { serverId: null, edition: 'normal', license: null, hermes: null };

function withEnterprise(s: EnterpriseView, d: EnterpriseState): EnterpriseView {
  // Everyone but the owner gets the edition alone: the license they had (none) stays.
  return { ...s, edition: d.edition, license: d.license === undefined ? s.license : d.license };
}

/** Pure reducer behind the store. */
export function enterpriseReducer(s: EnterpriseView, a: EnterpriseAction): EnterpriseView {
  switch (a.type) {
    case 'left':
      return initialEnterprise;
    case 'welcome': {
      const w = a.welcome as RendererWelcome & { enterprise?: unknown; hermes?: unknown };
      const ent = enterpriseStateSchemaClient.safeParse(w.enterprise);
      const hermes = hermesStateSchemaClient.safeParse(w.hermes);
      return {
        serverId: w.serverId,
        edition: ent.success ? ent.data.edition : 'normal',
        license: ent.success ? (ent.data.license ?? null) : null,
        hermes: w.hermes !== undefined && hermes.success ? hermes.data : null,
      };
    }
    case 'enterprise':
      return a.serverId !== s.serverId ? s : withEnterprise(s, a.state);
    case 'hermes':
      return a.serverId !== s.serverId ? s : { ...s, hermes: a.state };
    case 'event': {
      if (a.serverId !== s.serverId) return s;
      if (a.envelope.t === 'enterprise.state') {
        const p = enterpriseStateSchemaClient.safeParse(a.envelope.d);
        return p.success ? withEnterprise(s, p.data) : s;
      }
      if (a.envelope.t === 'hermes.state') {
        const p = hermesStateSchemaClient.safeParse(a.envelope.d);
        return p.success ? { ...s, hermes: p.data } : s;
      }
      return s;
    }
  }
}

interface EnterpriseStore extends EnterpriseView {
  dispatch(action: EnterpriseAction): void;
}

export const useEnterpriseStore = create<EnterpriseStore>()((set) => ({
  ...initialEnterprise,
  dispatch: (action) => set((s) => enterpriseReducer(s, action)),
}));

/** Mount once (MainLayout): the welcome on screen, then the server's events. */
export function useEnterpriseSync(): void {
  const welcome = useConnectionStore((s) => s.welcome);
  useLayoutEffect(() => {
    useEnterpriseStore.getState().dispatch(welcome ? { type: 'welcome', welcome } : { type: 'left' });
  }, [welcome]);
  useLayoutEffect(() => ghostlink().onServerEvent((envelope, serverId) => useEnterpriseStore.getState().dispatch({ type: 'event', serverId, envelope })), []);
}

// Not `window.ghostlink`: the node-side typecheck (tests) has no DOM types, as in chat/actions.ts.
function ghostlink(): GhostlinkApi {
  return (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink;
}

// Where the host screens are opened from: onboarding, "Seus servidores", the server
// rail's "+" button and the hosted server's header menu all call these functions;
// <HostScreens> (mounted once by App) shows the matching dialog over any layout.
import { create } from 'zustand';
import type { HostState } from '../../../shared/hostTypes.js';
import { useHostStore } from './hostStore.js';

export type HostUiView = 'closed' | 'form' | 'panel';

interface HostUiStore {
  view: HostUiView;
  show(view: HostUiView): void;
}

export const useHostUi = create<HostUiStore>()((set) => ({
  view: 'closed',
  show: (view) => set({ view }),
}));

/** "Hospedar um servidor" opens the form, or the panel while a server is hosted (one at a time, spec §9). */
export function hostFlowView(state: HostState | undefined): 'form' | 'panel' {
  return state === undefined || state === 'stopped' || state === 'failed' ? 'form' : 'panel';
}

/** Every "Hospedar um servidor" button (onboarding, server list, the rail's "+"). */
export function openHostFlow(): void {
  useHostUi.getState().show(hostFlowView(useHostStore.getState().status?.state));
}

/** The Host panel of the hosted server (hosting pill, server header menu). */
export function openHostPanel(): void {
  useHostUi.getState().show('panel');
}

export function closeHost(): void {
  useHostUi.getState().show('closed');
}

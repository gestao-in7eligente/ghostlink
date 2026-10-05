// "Criar um servidor" (owner's request, 2026-09-29): every entry point (the rail's "+",
// onboarding) first asks where the server lives: this computer (Host mode) or Railway.
// <CreateServerScreens>, mounted once by App, shows the matching dialog.
import { create } from 'zustand';
import { openHostFlow } from '../features/host/hostUi.js';

export type CreateServerView = 'closed' | 'choose' | 'railway';

export const useCreateServerUi = create<{ view: CreateServerView; show(view: CreateServerView): void }>()((set) => ({
  view: 'closed',
  show: (view) => set({ view }),
}));

export function openCreateServer(): void {
  useCreateServerUi.getState().show('choose');
}

export function closeCreateServer(): void {
  useCreateServerUi.getState().show('closed');
}

/** "Neste computador": the Host form (or its panel while a server is already hosted here). */
export function chooseLocal(): void {
  closeCreateServer();
  openHostFlow();
}

export function chooseRailway(): void {
  useCreateServerUi.getState().show('railway');
}

import { create } from 'zustand';

/**
 * "Entrar em um servidor" from the rail's "Adicionar servidor" dialog or the Home
 * screen: the Join screen, shown even over a connected server (cancel returns).
 */
export interface AddServerUi {
  join: boolean;
  openJoin(): void;
  closeJoin(): void;
}

export const useAddServerUi = create<AddServerUi>()((set) => ({
  join: false,
  openJoin: () => set({ join: true }),
  closeJoin: () => set({ join: false }),
}));

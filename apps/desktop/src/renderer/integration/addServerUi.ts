import { create } from 'zustand';

/**
 * The rail's "+" (owner requirement): a chooser modal "Adicionar servidor" with
 * "Criar um servidor" (Host flow) and "Entrar em um servidor" (Join screen).
 */
export interface AddServerUi {
  chooser: boolean;
  join: boolean;
  openChooser(): void;
  closeChooser(): void;
  /** Closes the chooser and shows the Join screen, even over a connected server. */
  openJoin(): void;
  closeJoin(): void;
}

export const useAddServerUi = create<AddServerUi>()((set) => ({
  chooser: false,
  join: false,
  openChooser: () => set({ chooser: true }),
  closeChooser: () => set({ chooser: false }),
  openJoin: () => set({ chooser: false, join: true }),
  closeJoin: () => set({ join: false }),
}));

export function openAddServer(): void {
  useAddServerUi.getState().openChooser();
}

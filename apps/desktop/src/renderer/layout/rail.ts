// The server rail's content and the "+" chooser's actions (owner's UI reference,
// 2026-09-28: "do lado esquerdo, abaixo da casinha, deve ter o +; aí abre um modal
// para criar um servidor ou entrar em um"). Pure, so the order is tested as rendered.
import type { SavedServer } from '../../shared/ipcTypes.js';
import type { LayoutSlots } from './slots.js';

export type RailEntry =
  | { kind: 'home' }
  | { kind: 'add' }
  | { kind: 'divider' }
  | { kind: 'server'; server: SavedServer }
  | { kind: 'extras' };

/** Top to bottom: home, the round "+" right below it, a divider, the saved servers, then Hosting's extras. */
export function railEntries(servers: readonly SavedServer[]): RailEntry[] {
  return [{ kind: 'home' }, { kind: 'add' }, { kind: 'divider' }, ...servers.map((server) => ({ kind: 'server' as const, server })), { kind: 'extras' }];
}

/**
 * What the chooser's two cards do: Hosting's flow ("Criar um servidor") and the
 * app's Join flow ("Entrar em um servidor") once registered — the integration step
 * wires them — and until then the server list, which offers both.
 */
export function addServerActions(
  slots: Pick<LayoutSlots, 'onCreateServer' | 'onJoinServer'>,
  onHome: () => void,
): { create: () => void; join: () => void } {
  return { create: slots.onCreateServer ?? onHome, join: slots.onJoinServer ?? onHome };
}

// Which profile card is open (spec 2026-10-02-cartao-de-perfil §1), one at a time so opening
// another one closes the first, and what the card's buttons do. No DOM types: the tests load it.
import { create } from 'zustand';
import type { Member } from '@ghostlink/shared';
import type { GhostlinkApi } from '../../../shared/ipcTypes.js';
import { textState } from '../../stores/text.js';
import { setMemberRoles } from '../chat/actions.js';
import { nextRoleIds, type CardRect, type CardSide } from './profileCardModel.js';

/** Where the focus goes back when the card closes: the clicked name, picture or member row. */
export interface CardOpener {
  readonly isConnected: boolean;
  focus(): void;
}

export interface OpenCard {
  /** New for every card, so each one mounts fresh. */
  id: number;
  /** The server on screen when it opened; on any other the card does not show. */
  serverId: string | null;
  userId: string;
  anchor: CardRect;
  side: CardSide;
  opener: CardOpener | null;
}

interface ProfileCardStore {
  card: OpenCard | null;
  /** Opens a person's card beside `anchor`; clicking the same name (or row) again closes it. */
  open(userId: string, anchor: CardRect, side: CardSide, opener?: CardOpener | null): void;
  close(): void;
}

let lastId = 0;

export const useProfileCardStore = create<ProfileCardStore>()((set, get) => ({
  card: null,
  open: (userId, anchor, side, opener = null) => {
    const current = get().card;
    if (current !== null && opener !== null && current.opener === opener && current.userId === userId) {
      set({ card: null });
      return;
    }
    const { left, top, right, bottom } = anchor;
    set({ card: { id: ++lastId, serverId: textState().server.serverId, userId, anchor: { left, top, right, bottom }, side, opener } });
  },
  close: () => {
    if (get().card !== null) set({ card: null });
  },
}));

/** window.ghostlink, reached through globalThis so the tests typecheck without the DOM types. */
const ghostlink = (): GhostlinkApi => (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink;

/** "Copiar ID do usuário": main copies it (the page has no clipboard permission). */
export function copyUserId(userId: string): Promise<void> {
  return ghostlink().app.copyText(userId);
}

/** The × on a role chip (`give` false) or a role from the "(+)" menu. Rejects with the server's code (HIERARCHY, FORBIDDEN…). */
export async function changeRole(member: Pick<Member, 'userId' | 'roleIds'>, roleId: string, give: boolean): Promise<void> {
  await setMemberRoles(member.userId, nextRoleIds(member.roleIds, roleId, give));
}


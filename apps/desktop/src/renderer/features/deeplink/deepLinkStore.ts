// ghostlink:// links in the page (spec §12): the invite is shown by the Join screen at its
// confirmation step ("Convite para X (nome informado pelo convite)", addresses, fingerprint).
import { create } from 'zustand';
import { formatFingerprint, type InvitePayload, type ParsedJoinInput } from '@ghostlink/shared';
import { initialJoin, joinReducer, type JoinState } from '../../screens/joinFlow.js';

interface DeepLinkStore {
  /** The invite being shown; null when none. */
  pending: InvitePayload | null;
  /** Shows a link's invite. Ignored (false) while another invite from a link is open. */
  offer(link: ParsedJoinInput): boolean;
  clear(): void;
}

export const useDeepLinkStore = create<DeepLinkStore>()((set, get) => ({
  pending: null,
  offer: (link) => {
    if (link.kind !== 'invite' || get().pending !== null) return false;
    set({ pending: link.invite });
    return true;
  },
  clear: () => set({ pending: null }),
}));

/** The Join flow already at the invite confirmation (nothing connects before "Aceitar convite"). */
export function joinStartFromLink(nickname: string, invite: InvitePayload): JoinState {
  return joinReducer(initialJoin(nickname), { type: 'parsed', parsed: { kind: 'invite', invite }, fingerprint: formatFingerprint(invite.serverKeyId) });
}

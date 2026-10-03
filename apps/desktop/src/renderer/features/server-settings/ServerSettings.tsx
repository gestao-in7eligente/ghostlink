import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FEATURE_ENTERPRISE } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { SettingsShell, type SettingsTab } from '../../layout/SettingsShell.js';
import { useConnectionStore } from '../../stores/connection.js';
import { isOwner, myPermissions } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { settingsTabs, type ServerSettingsTab } from './access.js';
import { BansTab } from './BansTab.js';
import { ChannelsTab } from './ChannelsTab.js';
import { InvitesTab } from './InvitesTab.js';
import { MembersTab } from './MembersTab.js';
import { OverviewTab } from './OverviewTab.js';
import { RolesTab } from './RolesTab.js';
import { EnterpriseTab } from '../enterprise/EnterpriseTab.js';
import { TransferTab } from './TransferTab.js';

/** The channel whose editor Canais opens with (the channel menu's "Editar canal"), until that editor closes. */
interface EditRequest {
  editId: string | undefined;
  done: () => void;
}

const CONTENT: Record<ServerSettingsTab, (edit: EditRequest) => ReactNode> = {
  overview: () => <OverviewTab />,
  channels: (edit) => <ChannelsTab editId={edit.editId} onEditClosed={edit.done} />,
  roles: () => <RolesTab />,
  members: () => <MembersTab />,
  invites: () => <InvitesTab />,
  bans: () => <BansTab />,
  enterprise: () => <EnterpriseTab />,
  transfer: () => <TransferTab />,
};

/**
 * Server settings (spec §11.1 item 6): only the tabs the user's permissions allow. `channelId`: the
 * channel menu's "Editar canal" opens Canais with that channel's editor.
 */
export function ServerSettings({ onClose, channelId }: { onClose: () => void; channelId?: string }) {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const enterprise = useConnectionStore((st) => st.welcome?.features.includes(FEATURE_ENTERPRISE) === true);
  const ids = useMemo(() => settingsTabs(myPermissions({ server, members }), isOwner(server), { enterprise }), [server, members, enterprise]);
  const [active, setActive] = useState<string>(channelId !== undefined && ids.includes('channels') ? 'channels' : (ids[0] ?? 'overview'));
  const [editId, setEditId] = useState(channelId);
  const edit: EditRequest = { editId, done: () => setEditId(undefined) };

  // Losing every permission (a role removed meanwhile) closes the dialog.
  useEffect(() => {
    if (ids.length === 0) onClose();
  }, [ids.length, onClose]);

  const tabs: SettingsTab[] = ids.map((id) => ({ id, label: t(`serverSettings.tab.${id}`), content: () => CONTENT[id](edit), danger: id === 'transfer' }));
  return <SettingsShell title={t('serverSettings.title')} tabs={tabs} active={active} onSelect={setActive} onClose={onClose} />;
}

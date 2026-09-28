import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/index.js';
import { SettingsShell, type SettingsTab } from '../../layout/SettingsShell.js';
import { isOwner, myPermissions } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { settingsTabs, type ServerSettingsTab } from './access.js';
import { BansTab } from './BansTab.js';
import { ChannelsTab } from './ChannelsTab.js';
import { InvitesTab } from './InvitesTab.js';
import { MembersTab } from './MembersTab.js';
import { OverviewTab } from './OverviewTab.js';
import { RolesTab } from './RolesTab.js';
import { TransferTab } from './TransferTab.js';

const CONTENT: Record<ServerSettingsTab, () => ReactNode> = {
  overview: () => <OverviewTab />,
  channels: () => <ChannelsTab />,
  roles: () => <RolesTab />,
  members: () => <MembersTab />,
  invites: () => <InvitesTab />,
  bans: () => <BansTab />,
  transfer: () => <TransferTab />,
};

/** Server settings (spec §11.1 item 6): only the tabs the user's permissions allow. */
export function ServerSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const ids = useMemo(() => settingsTabs(myPermissions({ server, members }), isOwner(server)), [server, members]);
  const [active, setActive] = useState<string>(ids[0] ?? 'overview');

  // Losing every permission (a role removed meanwhile) closes the dialog.
  useEffect(() => {
    if (ids.length === 0) onClose();
  }, [ids.length, onClose]);

  const tabs: SettingsTab[] = ids.map((id) => ({ id, label: t(`serverSettings.tab.${id}`), content: CONTENT[id], danger: id === 'transfer' }));
  return <SettingsShell title={t('serverSettings.title')} tabs={tabs} active={active} onSelect={setActive} onClose={onClose} />;
}

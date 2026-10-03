import { useMemo, useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import { FEATURE_ENTERPRISE_SITES, type Site } from '@ghostlink/shared';
import type { SavedServer } from '../../../shared/ipcTypes.js';
import { useT } from '../../i18n/index.js';
import l from '../../layout/layout.module.css';
import { ConfirmDialog, type MenuAnchor } from '../../layout/primitives.js';
import { TextChannelRow } from '../../layout/TextChannelRow.js';
import { useConnectionStore } from '../../stores/connection.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { isOwner } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { ChannelMenu, type ChannelMenuDialog } from '../channelMenu/ChannelMenu.js';
import { deleteSite } from './siteActions.js';
import { SiteDialog } from './SiteDialog.js';
import { canManageSites, showSitesSection, siteRows } from './siteModel.js';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'remove'; site: Site };

/**
 * SITES, right below BOTS (spec 2026-10-03-aba-api-e-sites §2): each site with a globe and its name; a
 * click opens its text channel like any channel. The owner and the page's role get "+" (Cadastrar site)
 * and, in the channel's menu, "Editar site" and "Remover site".
 */
export function SitesSection({ saved, onOpen }: { saved: SavedServer | null; onOpen: (dialog: ChannelMenuDialog, channelId: string) => void }) {
  const t = useT();
  const serverId = useTextStore((st) => st.server.serverId);
  const supported = useConnectionStore((st) => st.welcome?.serverId === serverId && st.welcome.features.includes(FEATURE_ENTERPRISE_SITES));
  const edition = useEnterpriseStore((st) => st.edition);
  const sites = useEnterpriseStore((st) => st.sites);
  const view = useEnterpriseStore((st) => st.view);
  const owner = useTextStore((st) => isOwner(st.server));
  const byId = useTextStore((st) => st.channels.byId);
  const rows = useMemo(() => siteRows(sites, byId), [sites, byId]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ site: Site; anchor: MenuAnchor } | null>(null);
  const canManage = canManageSites({ supported, edition, owner, view });
  if (!showSitesSection({ supported, edition, sites: rows.length, canManage })) return null;
  const menuChannel = menu && Object.hasOwn(byId, menu.site.channelId) ? byId[menu.site.channelId]! : null;

  return (
    <section className={l.section} aria-labelledby="section-sites" data-sites-section>
      <div className={l.sectionHeader}>
        <h2 id="section-sites" className={l.sectionTitle}>
          {t('sites.section')}
        </h2>
        {canManage && (
          <button type="button" className={l.sectionAdd} onClick={() => setDialog({ kind: 'create' })} aria-label={t('sites.add')} title={t('sites.add')}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className={l.channelList}>
        {rows.map(({ site, channel }) => (
          <TextChannelRow
            key={site.id}
            channel={channel}
            label={site.name}
            icon={<Globe className={l.channelIcon} size={18} aria-hidden="true" />}
            context={{ saved, now: Date.now(), openMenu: (_channelId, anchor) => setMenu({ site, anchor }) }}
          />
        ))}
      </ul>
      {rows.length === 0 && canManage && <p className={l.emptyHint}>{t('sites.empty')}</p>}

      {menu && menuChannel && (
        <ChannelMenu
          channel={menuChannel}
          anchor={menu.anchor}
          saved={saved}
          onClose={() => setMenu(null)}
          onOpen={onOpen}
          site={canManage ? { onEdit: () => setDialog({ kind: 'edit', site: menu.site }), onRemove: () => setDialog({ kind: 'remove', site: menu.site }) } : undefined}
        />
      )}
      {dialog?.kind === 'create' && <SiteDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <SiteDialog site={dialog.site} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          title={t('sites.removeTitle', { name: dialog.site.name })}
          body={t('sites.removeBody', { channel: byId[dialog.site.channelId]?.name ?? dialog.site.domain })}
          confirmLabel={t('sites.remove')}
          onConfirm={() => deleteSite(dialog.site.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { EllipsisVertical, KeyRound, Plus, Trash2 } from 'lucide-react';
import { FEATURE_BOTS, PERMISSIONS, has, type Member } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import l from '../../layout/layout.module.css';
import { Avatar, ConfirmDialog, Menu, MenuItem, MenuSeparator, type MenuAnchor } from '../../layout/primitives.js';
import { useConnectionStore } from '../../stores/connection.js';
import { myPermissions } from '../../stores/server.js';
import { useTextStore } from '../../stores/text.js';
import { deleteBot, regenerateBotCode } from './botActions.js';
import { AddBotDialog, BotCodeDialog } from './BotDialogs.js';
import { serverBots, showBotsSection } from './botsModel.js';
import b from './bots.module.css';

type Dialog =
  | { kind: 'create' }
  | { kind: 'regenerate' | 'delete'; bot: Member }
  | { kind: 'code'; name: string; code: string };

/**
 * BOTS in the server's sidebar, above "CANAIS DE TEXTO" (bots spec §3): each bot with its photo
 * and online dot. Whoever has MANAGE_SERVER sees "Adicionar bot" and each bot's menu (right click
 * or ⋮): "Gerar novo código" and "Excluir bot", both confirmed. Hidden when the server has no bots
 * and the person cannot create one.
 */
export function BotsSection() {
  const t = useT();
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const supported = useConnectionStore((s) => s.welcome?.serverId === server.serverId && s.welcome.features.includes(FEATURE_BOTS));
  const bots = useMemo(() => serverBots(members.byId), [members]);
  const canManage = useMemo(() => has(myPermissions({ server, members }), PERMISSIONS.MANAGE_SERVER), [server, members]);
  const [menu, setMenu] = useState<{ botId: string; anchor: MenuAnchor } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  if (!showBotsSection({ bots: bots.length, canManage, supported })) return null;
  const canAdd = canManage && supported;
  const menuBot = menu && Object.hasOwn(members.byId, menu.botId) ? members.byId[menu.botId]! : null;
  const pick = (kind: 'regenerate' | 'delete') => {
    if (menuBot) setDialog({ kind, bot: menuBot });
    setMenu(null);
  };

  return (
    <section className={l.section} aria-labelledby="section-bots" data-bots-section>
      <div className={l.sectionHeader}>
        <h2 id="section-bots" className={l.sectionTitle}>
          {t('bots.section')}
        </h2>
        {canAdd && (
          <button type="button" className={l.sectionAdd} onClick={() => setDialog({ kind: 'create' })} aria-label={t('bots.add')} title={t('bots.add')}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className={l.channelList}>
        {bots.map((bot) => (
          <BotRow key={bot.userId} bot={bot} canManage={canManage} open={menu?.botId === bot.userId} onMenu={(anchor) => setMenu({ botId: bot.userId, anchor })} />
        ))}
        {canAdd && bots.length === 0 && (
          <li>
            <button type="button" className={`${b.row} ${b.addRow}`} onClick={() => setDialog({ kind: 'create' })}>
              <span className={b.addIcon} aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className={b.rowName}>{t('bots.add')}</span>
            </button>
          </li>
        )}
      </ul>

      {menu && menuBot && (
        <Menu anchor={menu.anchor} label={t('bots.menu', { name: menuBot.nickname })} onClose={() => setMenu(null)} width={220}>
          <MenuItem onSelect={() => pick('regenerate')} icon={<KeyRound size={16} aria-hidden="true" />}>
            {t('bots.regenerate')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => pick('delete')} icon={<Trash2 size={16} aria-hidden="true" />}>
            {t('bots.delete')}
          </MenuItem>
        </Menu>
      )}

      {dialog?.kind === 'create' && <AddBotDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'code' && <BotCodeDialog name={dialog.name} code={dialog.code} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'regenerate' && (
        <ConfirmDialog
          title={t('bots.regenerate.title', { name: dialog.bot.nickname })}
          body={t('bots.regenerate.body')}
          confirmLabel={t('bots.regenerate')}
          onConfirm={async () => {
            const code = await regenerateBotCode(dialog.bot.userId);
            setDialog({ kind: 'code', name: dialog.bot.nickname, code });
          }}
          // After a success the code screen has taken its place: only a cancel closes it here.
          onClose={() => setDialog((d) => (d?.kind === 'regenerate' ? null : d))}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('bots.delete.title', { name: dialog.bot.nickname })}
          body={t('bots.delete.body')}
          confirmLabel={t('bots.delete')}
          onConfirm={() => deleteBot(dialog.bot.userId)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function BotRow({ bot, canManage, open, onMenu }: { bot: Member; canManage: boolean; open: boolean; onMenu: (anchor: MenuAnchor) => void }) {
  const t = useT();
  const status = bot.online ? t('layout.online') : t('members.statusOffline');
  const onContextMenu = (e: MouseEvent<HTMLLIElement>) => {
    if (!canManage) return;
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      onMenu(e.currentTarget.getBoundingClientRect());
    }
  };
  return (
    <li className={bot.online ? b.row : `${b.row} ${b.offline}`} onContextMenu={onContextMenu} data-bot={bot.userId}>
      <span className={b.rowMain} aria-label={t('bots.rowLabel', { name: bot.nickname, status })} role="img">
        <Avatar size={24} name={bot.nickname} hash={bot.avatar} online={bot.online} />
        <span className={b.rowName} aria-hidden="true">
          {bot.nickname}
        </span>
      </span>
      {canManage && (
        <button
          type="button"
          className={b.rowMore}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('bots.menu', { name: bot.nickname })}
          title={t('bots.menu', { name: bot.nickname })}
          onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}
          onKeyDown={onKeyDown}
        >
          <EllipsisVertical size={16} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

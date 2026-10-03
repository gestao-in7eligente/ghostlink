import { useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { EllipsisVertical, KeyRound, Plus, Settings, Trash2 } from 'lucide-react';
import { FEATURE_BOTS, PERMISSIONS, has, type Member } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import l from '../../layout/layout.module.css';
import { Avatar, Menu, MenuItem, MenuSeparator, type MenuAnchor } from '../../layout/primitives.js';
import { useConnectionStore } from '../../stores/connection.js';
import { centerView } from '../../stores/channels.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { isOwner, myPermissions } from '../../stores/server.js';
import { dispatchText, useTextStore } from '../../stores/text.js';
import { AddBotDialog, DeleteBotDialog, RegenerateBotDialog } from './BotDialogs.js';
import { BotSettings } from './BotSettings.js';
import { isSystemBot, serverBots, showBotsSection } from './botsModel.js';
import b from './bots.module.css';

type Dialog = { kind: 'create' } | { kind: 'settings'; botId: string } | { kind: 'regenerate' | 'delete'; bot: Member };

/**
 * BOTS in the server's sidebar, above "CANAIS DE TEXTO" (bots spec §3): each bot with its photo
 * and online dot; a click opens its page in the center, selected like a channel (bot page spec).
 * Whoever has MANAGE_SERVER sees "Adicionar bot" and each bot's menu (right click or ⋮):
 * "Configurações" (the bot's settings), then "Gerar novo código" and "Excluir bot", both
 * confirmed (not for the server's own bot, the Ghost DJ). Hidden when the server has no bots and
 * the person cannot create one.
 */
export function BotsSection() {
  const t = useT();
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const supported = useConnectionStore((s) => s.welcome?.serverId === server.serverId && s.welcome.features.includes(FEATURE_BOTS));
  const bots = useMemo(() => serverBots(members.byId), [members]);
  const selectedId = useTextStore((s) => (centerView(s.channels) === 'bot' ? s.channels.botPageId : null));
  const canManage = useMemo(() => has(myPermissions({ server, members }), PERMISSIONS.MANAGE_SERVER), [server, members]);
  const [menu, setMenu] = useState<{ botId: string; anchor: MenuAnchor } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  // The Ghost DJ has neither; the company Hermes's code and deletion are the owner's alone.
  const owner = useTextStore((s) => isOwner(s.server));
  const menuHermesLocked = useEnterpriseStore((e) => menu !== null && e.hermes?.botId === menu.botId) && !owner;
  const menuSystem = useTextStore((s) => menu !== null && isSystemBot(s.bots.profiles, menu.botId)) || menuHermesLocked;

  if (!showBotsSection({ bots: bots.length, canManage, supported })) return null;
  const canAdd = canManage && supported;
  const menuBot = menu && Object.hasOwn(members.byId, menu.botId) ? members.byId[menu.botId]! : null;
  const pick = (kind: 'settings' | 'regenerate' | 'delete') => {
    if (menuBot) setDialog(kind === 'settings' ? { kind, botId: menuBot.userId } : { kind, bot: menuBot });
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
          <BotRow
            key={bot.userId}
            bot={bot}
            selected={selectedId === bot.userId}
            canManage={canManage}
            open={menu?.botId === bot.userId}
            onMenu={(anchor) => setMenu({ botId: bot.userId, anchor })}
          />
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
          <MenuItem onSelect={() => pick('settings')} icon={<Settings size={16} aria-hidden="true" />}>
            {t('bots.settings')}
          </MenuItem>
          {!menuSystem && (
            <>
              <MenuItem onSelect={() => pick('regenerate')} icon={<KeyRound size={16} aria-hidden="true" />}>
                {t('bots.regenerate')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => pick('delete')} icon={<Trash2 size={16} aria-hidden="true" />}>
                {t('bots.delete')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}

      {dialog?.kind === 'create' && <AddBotDialog onClose={closeDialog} />}
      {dialog?.kind === 'settings' && <BotSettings botId={dialog.botId} onClose={closeDialog} />}
      {dialog?.kind === 'regenerate' && <RegenerateBotDialog bot={dialog.bot} onClose={closeDialog} />}
      {dialog?.kind === 'delete' && <DeleteBotDialog bot={dialog.bot} onClose={closeDialog} />}
    </section>
  );
}

function BotRow({
  bot,
  selected,
  canManage,
  open,
  onMenu,
}: {
  bot: Member;
  selected: boolean;
  canManage: boolean;
  open: boolean;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const t = useT();
  const status = bot.online ? t('layout.online') : t('members.statusOffline');
  const onContextMenu = (e: MouseEvent<HTMLLIElement>) => {
    if (!canManage) return;
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (canManage && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      onMenu(e.currentTarget.getBoundingClientRect());
    }
  };
  return (
    <li className={[b.row, bot.online ? '' : b.offline, selected ? b.rowSelected : ''].filter(Boolean).join(' ')} onContextMenu={onContextMenu} data-bot={bot.userId}>
      <button
        type="button"
        className={b.rowMain}
        aria-label={t('bots.rowLabel', { name: bot.nickname, status })}
        aria-current={selected ? 'page' : undefined}
        onClick={() => dispatchText({ type: 'bot.open', botId: bot.userId })}
        onKeyDown={onKeyDown}
        data-bot-open
      >
        <Avatar size={24} name={bot.nickname} hash={bot.avatar} online={bot.online} />
        <span className={b.rowName} aria-hidden="true">
          {bot.nickname}
        </span>
      </button>
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

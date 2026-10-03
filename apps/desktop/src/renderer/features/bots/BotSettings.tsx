import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, Check, CircleCheck, CircleX, ExternalLink, Hash, KeyRound, Lock, Trash2, X } from 'lucide-react';
import {
  BOT_LIMITS,
  FEATURE_BOT_SETTINGS,
  PERMISSIONS,
  has,
  roleColorHex,
  type BotChannelAccess,
  type BotDetails,
  type BotGetResult,
  type Member,
} from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { Avatar, ErrorText, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { SettingsShell, type SettingsTab } from '../../layout/SettingsShell.js';
import { useConnectionStore } from '../../stores/connection.js';
import { useEnterpriseStore } from '../../stores/enterprise.js';
import { everyoneRole, isOwner, myPermissions } from '../../stores/server.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { setMemberRoles } from '../chat/actions.js';
import { formatFull } from '../chat/grouping.js';
import { AvatarCropModal } from '../profile/AvatarCropModal.js';
import { IMAGE_ACCEPT, usePickedImage } from '../profile/usePickedImage.js';
import { getBot, setBotPhoto, updateBot } from './botActions.js';
import { DeleteBotDialog, RegenerateBotDialog } from './BotDialogs.js';
import { CommandList, useBotCommands } from './BotPage.js';
import { hermesSettingsTabs } from './hermes/HermesTabs.js';
import { BotTag, CreatedLine, SeenLine, fill, useNow } from './BotParts.js';
import { botRoleChoices, botsGuideUrl, isBot, isSystemBot, nameOf, refreshesBotSettings, seenText, timeAgo, toggledRole } from './botsModel.js';
import g from './botPage.module.css';
import b from './bots.module.css';

const TABS = ['overview', 'commands', 'activity', 'permissions', 'code', 'delete'] as const;
type BotSettingsTab = (typeof TABS)[number];

/** The longest name the field takes (the server keeps 1–32 visible characters, like a nickname). */
const NAME_MAX = 64;
/** A burst of events (a role change touches the member, the role and channels) loads once. */
const RELOAD_DELAY_MS = 250;

/** What `bot.get` answered, while the settings are open. */
interface BotData {
  data: BotGetResult | null;
  /** The last load failed (the data, if any, is the previous one). */
  error: string | null;
  reload(): void;
  /** The bot as `bot.update` answered, shown at once. */
  patch(bot: BotDetails): void;
}

/**
 * `bot.get` when the settings open, and again after anything that changes what they show (the
 * bot itself, its roles, the channels, a reconnect). A newer answer always wins.
 */
function useBotData(botId: string, enabled: boolean): BotData {
  const [state, setState] = useState<{ data: BotGetResult | null; error: string | null }>({ data: null, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const patch = useCallback((bot: BotDetails) => setState((st) => (st.data ? { ...st, data: { ...st.data, bot } } : st)), []);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    getBot(botId).then(
      (data) => current && setState({ data, error: null }),
      (e: unknown) => current && setState((st) => ({ ...st, error: errorCodeOf(e) })),
    );
    return () => {
      current = false;
    };
  }, [botId, enabled, version]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.ghostlink.onServerEvent((envelope, serverId) => {
      if (serverId !== useConnectionStore.getState().welcome?.serverId || !refreshesBotSettings(envelope, botId)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, RELOAD_DELAY_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [botId, enabled, reload]);

  return { ...state, reload, patch };
}

/**
 * The bot's settings (the bot's menu, "Configurações", bot page spec), in the server settings'
 * full-size dialog: Visão geral (photo, name, description), Comandos, Atividade (7 dias),
 * Permissões (where it sees and speaks, and its roles), Código de conexão and Excluir bot (neither
 * for the server's own bot, the Ghost DJ: "Bot do sistema" instead). For MANAGE_SERVER. A server without the bot's settings (before 0.4.2) shows what the app knows and
 * "Atualize o servidor para editar" where the server's data is needed. `initialTab`: the company
 * Hermes's page opens its Memória tab.
 */
export function BotSettings({ botId, initialTab = 'overview', onClose }: { botId: string; initialTab?: string; onClose: () => void }) {
  const t = useT();
  const bot = useTextStore((st) => (Object.hasOwn(st.members.byId, botId) ? st.members.byId[botId] : undefined));
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const canManage = useMemo(() => has(myPermissions({ server, members }), PERMISSIONS.MANAGE_SERVER), [server, members]);
  const supported = useConnectionStore((st) => st.welcome?.serverId === server.serverId && st.welcome.features.includes(FEATURE_BOT_SETTINGS));
  const data = useBotData(botId, supported && canManage && isBot(bot));
  const [active, setActive] = useState<string>(initialTab);
  const [dialog, setDialog] = useState<'regenerate' | 'delete' | null>(null);
  const systemProfile = useTextStore((st) => isSystemBot(st.bots.profiles, botId));
  const system = systemProfile || data.data?.bot.system === true;
  // The company Hermes (Enterprise): its own tabs. Owner only: a former owner may still hold a stale state.
  const companyHermes = useEnterpriseStore((st) => st.hermes?.botId === botId);
  const owner = useTextStore((st) => isOwner(st.server));
  const gone = !isBot(bot) || !canManage;

  // The bot was deleted meanwhile, or the person can no longer manage the server: nothing to show.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!isBot(bot)) return null;

  const content: Record<BotSettingsTab, () => ReactNode> = {
    overview: () => <OverviewTab bot={bot} data={data} supported={supported} system={system} />,
    commands: () => <CommandsTab botId={bot.userId} />,
    activity: () => <ActivityTab data={data} supported={supported} />,
    permissions: () => <PermissionsTab bot={bot} data={data} supported={supported} />,
    code: () => <CodeTab bot={bot} data={data} onRegenerate={() => setDialog('regenerate')} />,
    delete: () => <DeleteTab onDelete={() => setDialog('delete')} />,
  };
  const hideDanger = system;
  const tabs: SettingsTab[] = TABS.filter((id) => !hideDanger || (id !== 'code' && id !== 'delete')).map((id) => ({
    id,
    label: t(`bots.settings.tab.${id}`),
    content: content[id],
    danger: id === 'delete',
  }));
  if (companyHermes && owner) tabs.splice(1, 0, ...hermesSettingsTabs(t));
  const select = (id: string) => {
    setActive(id);
    // Uses and messages send no event here: the numbers are fetched again each time the tab opens.
    if (id === 'activity' && id !== active) data.reload();
  };
  return (
    <>
      <SettingsShell title={t('bots.settings.title', { name: bot.nickname })} tabs={tabs} active={active} onSelect={select} onClose={onClose} />
      {dialog === 'regenerate' && <RegenerateBotDialog bot={bot} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteBotDialog bot={bot} onClose={() => setDialog(null)} />}
    </>
  );
}

/** "Atualize o servidor para editar": a server before 0.4.2 has no bot.get nor bot.update. */
function Outdated() {
  const t = useT();
  return (
    <p className={s.warning} data-bot-outdated>
      {t('bots.settings.outdated')}
    </p>
  );
}

/** The part of a tab that needs `bot.get`: "Carregando…" first, or the error with "Tentar de novo". */
function Loaded({ data, children }: { data: BotData; children: (got: BotGetResult) => ReactNode }) {
  const t = useT();
  if (data.data) return <>{children(data.data)}</>;
  if (data.error) {
    return (
      <>
        <ErrorText code={data.error} />
        <div className={s.row}>
          <button type="button" className={p.button} onClick={data.reload}>
            {t('common.tryAgain')}
          </button>
        </div>
      </>
    );
  }
  return <p className={s.hint}>{t('app.loading')}</p>;
}

// ---- Visão geral ----

function OverviewTab({ bot, data, supported, system }: { bot: Member; data: BotData; supported: boolean; system: boolean }) {
  const t = useT();
  const nameId = useId();
  const descriptionId = useId();
  const input = useRef<HTMLInputElement>(null);
  const picking = usePickedImage(t('profile.photo.unreadable'));
  const info = data.data?.bot ?? null;
  const saved = { name: bot.nickname, description: info?.description ?? '' };
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const shown = draft ?? saved;
  const changes: { name?: string; description?: string } = {};
  if (shown.name.trim() !== saved.name) changes.name = shown.name.trim();
  if (shown.description !== saved.description) changes.description = shown.description;
  const editable = supported && info !== null;
  const canSave = editable && !busy && shown.name.trim() !== '' && Object.keys(changes).length > 0;

  const edit = (next: Partial<{ name: string; description: string }>) => {
    setDraft({ ...shown, ...next });
    setDone(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      data.patch(await updateBot(bot.userId, changes));
      setDraft(null);
      setDone(true);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.form}>
      <div className={g.overviewTop}>
        <Avatar size={80} name={bot.nickname} hash={bot.avatar} />
        <div className={g.overviewIdentity}>
          <p className={g.overviewName}>
            <span className={g.nameText}>{bot.nickname}</span>
            <BotTag t={t} />
          </p>
          {info && <CreatedLine createdBy={info.createdBy} createdAt={info.createdAt} />}
          <SeenLine online={bot.online} lastSeenAt={info ? info.lastSeenAt : undefined} />
          {system && (
            <p className={s.hint} data-bot-system>
              <strong>{t('bots.settings.system')}</strong> · {t('bots.settings.systemHint')}
            </p>
          )}
          <button type="button" className={p.button} onClick={() => input.current?.click()} disabled={picking.opening} data-bot-photo-change>
            {t('bots.create.photoChange')}
          </button>
        </div>
      </div>
      <p className={s.hint}>{t('bots.settings.photoHint')}</p>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => void picking.onFile(e)} data-bot-photo-input />
      {picking.error && ('code' in picking.error ? <ErrorText code={picking.error.code} /> : <p className={p.error} role="alert">{picking.error.text}</p>)}

      <form className={s.form} onSubmit={(e) => void submit(e)} data-bot-overview>
        {!supported && <Outdated />}
        <div className={s.field}>
          <label htmlFor={nameId} className={s.label}>
            {t('bots.create.name')}
          </label>
          <input
            id={nameId}
            className={s.input}
            value={shown.name}
            maxLength={NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={!editable || busy}
            onChange={(e) => edit({ name: e.target.value })}
          />
          <p className={s.hint}>{t('bots.create.nameHint')}</p>
        </div>
        {supported && (
          <div className={s.field}>
            <label htmlFor={descriptionId} className={s.label}>
              {t('bots.settings.description')}
            </label>
            <textarea
              id={descriptionId}
              className={s.textarea}
              rows={5}
              value={shown.description}
              maxLength={BOT_LIMITS.botDescriptionMax}
              disabled={!editable || busy}
              onChange={(e) => edit({ description: e.target.value })}
            />
            <div className={g.fieldFoot}>
              <span className={s.hint}>{t('bots.settings.descriptionHint')}</span>
              <span className={g.counter} data-bot-description-count>
                {shown.description.length}/{BOT_LIMITS.botDescriptionMax}
              </span>
            </div>
          </div>
        )}
        {supported && info === null && <Loaded data={data}>{() => null}</Loaded>}
        {error && <ErrorText code={error} />}
        {done && <p className={s.ok}>{t('serverSettings.saved')}</p>}
        {supported && (
          <div className={s.row}>
            <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={!canSave}>
              {t('serverSettings.save')}
            </button>
          </div>
        )}
      </form>
      {picking.picked && <AvatarCropModal picked={picking.picked} onApply={(bytes) => setBotPhoto(bot.userId, bytes)} onClose={picking.close} />}
    </div>
  );
}

// ---- Comandos ----

/** The real commands, as on the bot's page. */
function CommandsTab({ botId }: { botId: string }) {
  return <CommandList commands={useBotCommands(botId)} />;
}

// ---- Atividade (7 dias) ----

function ActivityTab({ data, supported }: { data: BotData; supported: boolean }) {
  if (!supported) return <Outdated />;
  return (
    <div className={s.form}>
      <Loaded data={data}>{(got) => <Activity got={got} />}</Loaded>
    </div>
  );
}

function Activity({ got }: { got: BotGetResult }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const members = useTextStore((st) => st.members.byId);
  const channels = useTextStore((st) => st.channels.byId);
  const selfId = useTextStore((st) => st.server.selfId);
  const now = useNow();
  const max = Math.max(1, ...got.usage.map((u) => u.count));
  return (
    <>
      <p className={g.stat} data-bot-messages>
        {t('bots.activity.messages24h')}: <span className={g.statValue}>{got.messagesLast24h}</span>
      </p>
      <section className={g.block} aria-labelledby="bot-activity-uses">
        <h4 id="bot-activity-uses" className={g.blockTitle}>
          {t('bots.activity.uses')}
        </h4>
        {got.usage.length === 0 ? (
          <p className={s.hint}>{t('bots.activity.noUses')}</p>
        ) : (
          <ul className={g.bars}>
            {got.usage.map((u) => (
              <li key={u.command} className={g.bar} title={t('bots.activity.usesTitle', { command: `/${u.command}`, count: u.count })} data-bot-usage={u.command}>
                <span className={g.barLabel}>/{u.command}</span>
                <span className={g.barTrack} aria-hidden="true">
                  <span className={g.barFill} style={{ width: `${(u.count / max) * 100}%` }} />
                </span>
                <span className={g.barValue}>{u.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={g.block} aria-labelledby="bot-activity-recent">
        <h4 id="bot-activity-recent" className={g.blockTitle}>
          {t('bots.activity.recent')}
        </h4>
        {got.recent.length === 0 ? (
          <p className={s.hint}>{t('bots.activity.noRecent')}</p>
        ) : (
          <ul className={g.recent}>
            {got.recent.map((r, i) => {
              const who = nameOf(members, r.userId, t('chat.formerMember'));
              const channel = Object.hasOwn(channels, r.channelId) ? `#${channels[r.channelId]!.name}` : t('bots.activity.deletedChannel');
              return (
                <li key={`${r.at}-${r.userId}-${i}`} className={g.recentRow} data-bot-use={r.command}>
                  <Avatar size={28} name={who} hash={Object.hasOwn(members, r.userId) ? members[r.userId]!.avatar : null} self={r.userId === selfId} />
                  <span className={g.recentText}>
                    <span className={g.recentWho}>{fill(t('slash.used'), { name: who, command: <span className={g.recentCommand}>/{r.command}</span> })}</span>
                    <span className={g.recentMeta} title={formatFull(r.at, locale)}>
                      {channel} · {timeAgo(r.at, now, locale)}
                    </span>
                  </span>
                  {r.answered ? (
                    <span className={g.answered}>
                      <CircleCheck size={14} aria-hidden="true" />
                      {t('bots.activity.answered')}
                    </span>
                  ) : (
                    <span className={g.unanswered}>
                      <CircleX size={14} aria-hidden="true" />
                      {t('bots.activity.unanswered')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

// ---- Permissões ----

function YesNo({ value }: { value: boolean }) {
  const t = useT();
  return (
    <span role="img" aria-label={value ? t('slash.yes') : t('slash.no')}>
      {value ? <Check className={g.yes} size={16} aria-hidden="true" /> : <X className={g.no} size={16} aria-hidden="true" />}
    </span>
  );
}

function PermissionsTab({ bot, data, supported }: { bot: Member; data: BotData; supported: boolean }) {
  const t = useT();
  return (
    <div className={s.form}>
      <p className={p.text}>{t('bots.permissions.intro')}</p>
      {supported ? <Loaded data={data}>{(got) => <ChannelTable access={got.channels} />}</Loaded> : <Outdated />}
      <BotRoles bot={bot} onChanged={data.reload} />
    </div>
  );
}

/** Where the bot sees and speaks, by the server's own rules: every text channel I see, in order. */
function ChannelTable({ access }: { access: readonly BotChannelAccess[] }) {
  const t = useT();
  const channels = useTextStore((st) => st.channels.byId);
  const rows = access.filter((a) => Object.hasOwn(channels, a.channelId));
  return (
    <table className={g.table} data-bot-channels>
      <thead>
        <tr>
          <th scope="col">{t('bots.permissions.channel')}</th>
          <th scope="col" className={g.cellCenter}>
            {t('bots.permissions.sees')}
          </th>
          <th scope="col" className={g.cellCenter}>
            {t('bots.permissions.speaks')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const channel = channels[a.channelId]!;
          return (
            <tr key={a.channelId} data-bot-channel={channel.name}>
              <td>
                <span className={g.channelCell}>
                  <Hash className={g.channelIcon} size={16} aria-hidden="true" />
                  {channel.name}
                  {channel.private && <Lock className={g.channelIcon} size={12} aria-hidden="true" />}
                </span>
              </td>
              <td className={g.cellCenter}>
                <YesNo value={a.view} />
              </td>
              <td className={g.cellCenter}>
                <YesNo value={a.send} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The bot's roles: the ones I may give or take are checkboxes (member.setRoles, as in the member menu). */
function BotRoles({ bot, onChanged }: { bot: Member; onChanged: () => void }) {
  const t = useT();
  const server = useTextStore((st) => st.server);
  const members = useTextStore((st) => st.members);
  const choices = useMemo(() => botRoleChoices({ server, members }, bot.userId), [server, members, bot.userId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = choices.some((c) => c.editable);

  const toggle = async (roleId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setMemberRoles(bot.userId, toggledRole(bot.roleIds, roleId));
      onChanged();
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={g.block} aria-labelledby="bot-permissions-roles" data-bot-roles>
      <h4 id="bot-permissions-roles" className={g.blockTitle}>
        {t('bots.permissions.rolesTitle')}
      </h4>
      <p className={s.hint}>{canEdit ? t('bots.permissions.rolesHint') : t('bots.permissions.rolesReadOnly')}</p>
      {choices.length === 0 ? (
        <p className={s.hint}>{t('bots.permissions.onlyEveryone', { role: everyoneRole(server.roles)?.name ?? '@todos' })}</p>
      ) : (
        <ul className={g.roles}>
          {choices.map(({ role, checked, editable }) => {
            const color = roleColorHex(role.color);
            return (
              <li key={role.id}>
                <label className={s.check} data-bot-role={role.name}>
                  <input type="checkbox" checked={checked} disabled={!editable || busy} onChange={() => void toggle(role.id)} />
                  <span className={`${s.roleSwatch} ${g.roleSwatch}`} style={color ? { background: color } : undefined} aria-hidden="true" />
                  <span className={g.roleName}>{role.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error && <ErrorText code={error} />}
    </section>
  );
}

// ---- Código de conexão ----

function CodeTab({ bot, data, onRegenerate }: { bot: Member; data: BotData; onRegenerate: () => void }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const now = useNow();
  const lastSeenAt = data.data ? data.data.bot.lastSeenAt : undefined;
  return (
    <div className={s.form}>
      <section className={g.block} aria-labelledby="bot-code-state">
        <h4 id="bot-code-state" className={g.blockTitle}>
          {t('bots.code.state')}
        </h4>
        <p className={g.status} data-bot-connection>
          <span className={bot.online ? `${g.statusDot} ${g.statusOn}` : g.statusDot} aria-hidden="true" />
          {bot.online ? t('bots.code.online') : seenText(t, false, lastSeenAt, now, locale)}
        </p>
      </section>
      <section className={g.block} aria-labelledby="bot-code-steps">
        <h4 id="bot-code-steps" className={g.blockTitle}>
          {t('bots.code.steps')}
        </h4>
        <ol className={g.steps}>
          <li>{t('bots.code.step1')}</li>
          <li>{fill(t('bots.code.step2'), { env: <code className={g.inlineCode}>GHOSTLINK_BOT</code> })}</li>
          <li>
            {fill(t('bots.code.step3'), {
              from: <code className={g.inlineCode}>from &apos;discord.js&apos;</code>,
              to: <code className={g.inlineCode}>from &apos;@ghostlink/discord-compat&apos;</code>,
            })}
          </li>
        </ol>
        <button type="button" className={b.guide} onClick={() => void window.ghostlink.app.openExternal(botsGuideUrl(locale)).catch(() => undefined)}>
          <BookOpen size={16} aria-hidden="true" />
          {t('bots.code.guide')}
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      </section>
      <p className={p.text}>{t('bots.code.about')}</p>
      <div className={s.row}>
        <button type="button" className={p.button} onClick={onRegenerate} data-bot-regenerate>
          <KeyRound size={16} aria-hidden="true" />
          {t('bots.regenerate')}
        </button>
      </div>
    </div>
  );
}

// ---- Excluir bot ----

function DeleteTab({ onDelete }: { onDelete: () => void }) {
  const t = useT();
  return (
    <div className={s.form}>
      <p className={p.text}>{t('bots.delete.body')}</p>
      <div className={s.row}>
        <button type="button" className={`${p.button} ${p.buttonDanger}`} onClick={onDelete} data-bot-delete>
          <Trash2 size={16} aria-hidden="true" />
          {t('bots.delete')}
        </button>
      </div>
    </div>
  );
}

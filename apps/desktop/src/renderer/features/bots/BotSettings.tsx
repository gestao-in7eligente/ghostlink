import { useEffect, useState, type ReactNode } from 'react';
import { Check, CircleCheck, CircleX, Hash, KeyRound, Lock, Trash2, X } from 'lucide-react';
import type { Member } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { Avatar, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { SettingsShell, type SettingsTab } from '../../layout/SettingsShell.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { CommandList, useBotCommands } from './BotPage.js';
import { BotTag, fill } from './BotParts.js';
import { isBot } from './botsModel.js';
import g from './botPage.module.css';

const TABS = ['overview', 'commands', 'activity', 'permissions', 'code', 'delete'] as const;
type BotSettingsTab = (typeof TABS)[number];

// The mockup's sample data (bot page spec, owner 2026-10-02: "Deixe apenas em mockup"): fixed
// values shown under "Prévia" until the server keeps a description, the uses and the interactions.
const SAMPLE_MESSAGES_TODAY = 12;
const SAMPLE_USES = [
  { command: 'ping', count: 42 },
  { command: 'ajuda', count: 17 },
  { command: 'dado', count: 9 },
  { command: 'clima', count: 4 },
] as const;
const SAMPLE_RECENT = [
  { who: 'Ana', command: 'ping', channel: 'geral', minutesAgo: 5, answered: true },
  { who: 'Bruno', command: 'dado', channel: 'geral', minutesAgo: 48, answered: true },
  { who: 'Carla', command: 'clima', channel: 'comandos', minutesAgo: 180, answered: false },
  { who: 'Diego', command: 'ajuda', channel: 'geral', minutesAgo: 1_440, answered: true },
  { who: 'Eva', command: 'ping', channel: 'avisos', minutesAgo: 2_880, answered: true },
] as const;
const SAMPLE_CHANNELS = [
  { name: 'geral', private: false, sees: true, speaks: true },
  { name: 'comandos', private: false, sees: true, speaks: true },
  { name: 'avisos', private: false, sees: true, speaks: false },
  { name: 'staff', private: true, sees: false, speaks: false },
] as const;

/** "há 5 minutos", "ontem"… in the app's language. */
function ago(minutes: number, locale: string): string {
  const f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return f.format(-minutes, 'minute');
  if (minutes < 1_440) return f.format(-Math.round(minutes / 60), 'hour');
  return f.format(-Math.round(minutes / 1_440), 'day');
}

/**
 * The bot's settings (the bot's menu, "Configurações"), in the server settings' full-size dialog.
 * A mockup for now (bot page spec): the commands are real; the rest is sample data under "Prévia"
 * and every action is disabled with "Em breve" — the menu's "Gerar novo código" and "Excluir bot"
 * are the working ones.
 */
export function BotSettings({ botId, onClose }: { botId: string; onClose: () => void }) {
  const t = useT();
  const bot = useTextStore((st) => (Object.hasOwn(st.members.byId, botId) ? st.members.byId[botId] : undefined));
  const [active, setActive] = useState<string>('overview');
  const gone = !isBot(bot);

  // The bot was deleted meanwhile: nothing left to show.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!isBot(bot)) return null;

  const content: Record<BotSettingsTab, () => ReactNode> = {
    overview: () => <OverviewTab bot={bot} />,
    commands: () => <CommandsTab botId={bot.userId} />,
    activity: () => <ActivityTab />,
    permissions: () => <PermissionsTab />,
    code: () => <CodeTab />,
    delete: () => <DeleteTab />,
  };
  const tabs: SettingsTab[] = TABS.map((id) => ({ id, label: t(`bots.settings.tab.${id}`), content: content[id], danger: id === 'delete' }));
  return <SettingsShell title={t('bots.settings.title', { name: bot.nickname })} tabs={tabs} active={active} onSelect={setActive} onClose={onClose} />;
}

/** The "Prévia" label on sample blocks, so nobody takes them for real data. */
function Preview() {
  const t = useT();
  return (
    <p className={g.preview} data-preview>
      <span className={g.previewTag}>{t('bots.preview')}</span>
      {t('bots.preview.note')}
    </p>
  );
}

function OverviewTab({ bot }: { bot: Member }) {
  const t = useT();
  const soon = t('common.comingSoon');
  return (
    <div className={s.form}>
      <Preview />
      <div className={g.overviewTop}>
        <Avatar size={80} name={bot.nickname} hash={bot.avatar} />
        <div className={g.overviewIdentity}>
          <p className={g.overviewName}>
            <span className={g.nameText}>{bot.nickname}</span>
            <BotTag t={t} />
          </p>
          <p className={g.created}>{t('bots.settings.createdSample')}</p>
          <button type="button" className={p.button} disabled title={soon}>
            {t('bots.create.photoChange')}
          </button>
        </div>
      </div>
      <label className={s.field}>
        <span className={s.label}>{t('bots.create.name')}</span>
        <input className={`${s.input} ${g.locked}`} value={bot.nickname} readOnly disabled title={soon} />
      </label>
      <label className={s.field}>
        <span className={s.label}>{t('bots.settings.description')}</span>
        <textarea className={`${s.textarea} ${g.locked}`} rows={4} value={t('bots.settings.descriptionSample')} readOnly disabled title={soon} />
        <span className={s.hint}>{t('bots.settings.descriptionHint')}</span>
      </label>
      <div className={s.row}>
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled title={soon}>
          {t('serverSettings.save')}
        </button>
      </div>
    </div>
  );
}

/** The real commands, as on the bot's page. */
function CommandsTab({ botId }: { botId: string }) {
  return <CommandList commands={useBotCommands(botId)} />;
}

function ActivityTab() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const max = Math.max(...SAMPLE_USES.map((u) => u.count));
  return (
    <div className={s.form}>
      <Preview />
      <p className={g.stat} data-bot-messages-today>
        {t('bots.activity.messagesToday')}: <span className={g.statValue}>{SAMPLE_MESSAGES_TODAY}</span>
      </p>
      <section className={g.block} aria-labelledby="bot-activity-uses">
        <h4 id="bot-activity-uses" className={g.blockTitle}>
          {t('bots.activity.uses')}
        </h4>
        <ul className={g.bars}>
          {SAMPLE_USES.map((u) => (
            <li key={u.command} className={g.bar} title={t('bots.activity.usesTitle', { command: `/${u.command}`, count: u.count })}>
              <span className={g.barLabel}>/{u.command}</span>
              <span className={g.barTrack} aria-hidden="true">
                <span className={g.barFill} style={{ width: `${(u.count / max) * 100}%` }} />
              </span>
              <span className={g.barValue}>{u.count}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className={g.block} aria-labelledby="bot-activity-recent">
        <h4 id="bot-activity-recent" className={g.blockTitle}>
          {t('bots.activity.recent')}
        </h4>
        <ul className={g.recent}>
          {SAMPLE_RECENT.map((r) => (
            <li key={`${r.who}-${r.minutesAgo}`} className={g.recentRow}>
              <Avatar size={28} name={r.who} />
              <span className={g.recentText}>
                <span className={g.recentWho}>{fill(t('slash.used'), { name: r.who, command: <span className={g.recentCommand}>/{r.command}</span> })}</span>
                <span className={g.recentMeta}>
                  #{r.channel} · {ago(r.minutesAgo, locale)}
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
          ))}
        </ul>
      </section>
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  const t = useT();
  return (
    <span role="img" aria-label={value ? t('slash.yes') : t('slash.no')}>
      {value ? <Check className={g.yes} size={16} aria-hidden="true" /> : <X className={g.no} size={16} aria-hidden="true" />}
    </span>
  );
}

function PermissionsTab() {
  const t = useT();
  return (
    <div className={s.form}>
      <Preview />
      <p className={p.text}>{t('bots.permissions.intro')}</p>
      <table className={g.table}>
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
          {SAMPLE_CHANNELS.map((c) => (
            <tr key={c.name}>
              <td>
                <span className={g.channelCell}>
                  <Hash className={g.channelIcon} size={16} aria-hidden="true" />
                  {c.name}
                  {c.private && <Lock className={g.channelIcon} size={12} aria-hidden="true" />}
                </span>
              </td>
              <td className={g.cellCenter}>
                <YesNo value={c.sees} />
              </td>
              <td className={g.cellCenter}>
                <YesNo value={c.speaks} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={s.row}>
        <button type="button" className={p.button} disabled title={t('common.comingSoon')}>
          {t('bots.permissions.roles')}
        </button>
        <span className={s.hint}>{t('bots.permissions.rolesHint')}</span>
      </div>
    </div>
  );
}

function CodeTab() {
  const t = useT();
  return (
    <div className={s.form}>
      <Preview />
      <p className={p.text}>{t('bots.code.about')}</p>
      <div className={s.row}>
        <button type="button" className={p.button} disabled title={t('common.comingSoon')}>
          <KeyRound size={16} aria-hidden="true" />
          {t('bots.regenerate')}
        </button>
      </div>
      <p className={s.hint}>{t('bots.settings.menuHint')}</p>
    </div>
  );
}

function DeleteTab() {
  const t = useT();
  return (
    <div className={s.form}>
      <Preview />
      <p className={p.text}>{t('bots.delete.body')}</p>
      <div className={s.row}>
        <button type="button" className={`${p.button} ${p.buttonDanger}`} disabled title={t('common.comingSoon')}>
          <Trash2 size={16} aria-hidden="true" />
          {t('bots.delete')}
        </button>
      </div>
      <p className={s.hint}>{t('bots.settings.menuHint')}</p>
    </div>
  );
}

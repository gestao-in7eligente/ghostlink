import { useEffect, useState, type FormEvent } from 'react';
import type { AppInfo, Locale } from '../../shared/ipcTypes.js';
import { updateProfile } from '../features/chat/actions.js';
import { ProfilePhoto } from '../features/profile/ProfilePhoto.js';
import x from '../features/profile/profile.module.css';
import { errorCodeOf, useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settings.js';
import { useTextStore } from '../stores/text.js';
import { ErrorText, primitives as p } from './primitives.js';
import s from './settings.module.css';
import { SettingsShell, type SettingsTab } from './SettingsShell.js';
import { suggestNickname } from './names.js';
import { useLayoutSlots } from './slots.js';

/** User settings (spec §11.1 item 7): profile, language, the other tracks' sections, about. */
export function UserSettings({ onClose, offline = false }: { onClose: () => void; /** Home screen: no server, so the profile is the photo only. */ offline?: boolean }) {
  const t = useT();
  const extra = useLayoutSlots((st) => st.userSettingsSections);
  const [active, setActive] = useState('profile');
  const tabs: SettingsTab[] = [
    { id: 'profile', label: t('userSettings.profile'), content: () => (offline ? <HomeProfileTab /> : <ProfileTab />) },
    { id: 'language', label: t('language.label'), content: () => <LanguageTab /> },
    ...extra.map((section) => ({ id: `x:${section.id}`, label: t(section.title), content: () => <section.Component /> })),
    { id: 'about', label: t('userSettings.about'), content: () => <AboutTab /> },
  ];
  return <SettingsShell title={t('layout.userSettings')} tabs={tabs} active={active} onSelect={setActive} onClose={onClose} />;
}

/** The Home screen's Perfil tab: only the photo (one for every server); the initials use the global nickname. */
function HomeProfileTab() {
  const nickname = useSettingsStore((st) => st.settings?.nickname ?? '');
  return (
    <div className={s.form}>
      <ProfilePhoto name={nickname} />
    </div>
  );
}

/** Inside a server: the photo, then this server's nickname. */
function ProfileTab() {
  const nickname = useTextStore((st) => (Object.hasOwn(st.members.byId, st.server.selfId) ? st.members.byId[st.server.selfId]!.nickname : ''));
  return (
    <div className={s.form}>
      <ProfilePhoto name={nickname} />
      <hr className={x.divider} />
      <NicknameForm />
    </div>
  );
}

function NicknameForm() {
  const t = useT();
  const current = useTextStore((st) => (Object.hasOwn(st.members.byId, st.server.selfId) ? st.members.byId[st.server.selfId]!.nickname : ''));
  const serverName = useTextStore((st) => st.server.name);
  const [nickname, setNickname] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateProfile(nickname);
      setSaved(true);
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={s.form} onSubmit={(e) => void submit(e)}>
      <label className={s.field}>
        <span className={s.label}>{t('userSettings.nickname')}</span>
        <input className={s.input} value={nickname} maxLength={64} onChange={(e) => setNickname(e.target.value)} autoComplete="off" spellCheck={false} />
        <span className={s.hint}>{t('userSettings.nicknameHint', { server: serverName })}</span>
      </label>
      {error && <ErrorText code={error} />}
      {error === 'NICK_TAKEN' && (
        <div className={s.row}>
          <button type="button" className={p.button} onClick={() => setNickname(suggestNickname(nickname.trim()))}>
            {t('userSettings.useSuggestion', { nickname: suggestNickname(nickname.trim()) })}
          </button>
        </div>
      )}
      {saved && <p className={s.ok}>{t('serverSettings.saved')}</p>}
      <div className={s.row}>
        <button type="submit" className={`${p.button} ${p.buttonPrimary}`} disabled={busy || nickname.trim() === '' || nickname === current}>
          {t('serverSettings.save')}
        </button>
      </div>
    </form>
  );
}

function LanguageTab() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [error, setError] = useState<string | null>(null);
  const choose = async (next: Locale) => {
    setError(null);
    try {
      useSettingsStore.getState().setSettings(await window.ghostlink.settings.set({ locale: next }));
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };
  return (
    <div className={s.form}>
      <div className={s.radioGroup} role="radiogroup" aria-label={t('language.label')}>
        {(['pt-BR', 'en'] as const).map((l) => (
          <label key={l} className={s.choice}>
            <input type="radio" name="locale" checked={locale === l} onChange={() => void choose(l)} />
            <span className={s.choiceTitle}>{t(`language.${l}`)}</span>
          </label>
        ))}
      </div>
      {error && <ErrorText code={error} />}
    </div>
  );
}

function AboutTab() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let alive = true;
    window.ghostlink.app.info().then(
      (i) => alive && setInfo(i),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className={s.form}>
      <p className={s.hint}>{t('userSettings.version', { version: info?.version ?? '…' })}</p>
      <p className={s.hint}>{t('userSettings.license')}</p>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { IdentityStatus, Locale } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settings.js';

type Step = 'welcome' | 'profile' | 'backup' | 'choose';
const LOCALES: Locale[] = ['pt-BR', 'en'];

/**
 * spec §11.1: welcome → language + nickname (the identity is created here) →
 * backup notice → Join or Host (Host arrives in Milestone 7).
 */
export function Onboarding({ identity, onDone }: { identity: IdentityStatus; onDone: () => void }) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const [step, setStep] = useState<Step>('welcome');
  const [nickname, setNickname] = useState(settings?.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorCode | null>(null);

  const changeLocale = async (locale: Locale) => {
    setError(null);
    try {
      setSettings(await window.ghostlink.settings.set({ locale }));
    } catch (e) {
      setError(errorCodeOf(e));
    }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSettings(await window.ghostlink.settings.set({ nickname }));
      if (identity === 'none') await window.ghostlink.identity.create();
      setStep('backup');
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'welcome') {
    return (
      <Screen title={t('onboarding.welcome.title')}>
        <p className={ui.text}>{t('onboarding.welcome.body')}</p>
        <div className={ui.actions}>
          <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => setStep('profile')}>
            {t('onboarding.welcome.start')}
          </button>
        </div>
      </Screen>
    );
  }

  if (step === 'profile') {
    return (
      <Screen title={t('onboarding.profile.title')}>
        <form className={ui.form} onSubmit={(e) => void saveProfile(e)}>
          <label className={ui.field}>
            <span className={ui.label}>{t('language.label')}</span>
            <select className={ui.input} value={settings?.locale} onChange={(e) => void changeLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`language.${l}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={ui.field}>
            <span className={ui.label}>{t('onboarding.profile.nickname')}</span>
            <input className={ui.input} value={nickname} maxLength={64} autoFocus onChange={(e) => setNickname(e.target.value)} />
            <span className={ui.hint}>{t('onboarding.profile.nicknameHint')}</span>
          </label>
          <ErrorLine text={error && errorMessage(t, error)} />
          <div className={ui.actions}>
            <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={busy || nickname.trim() === ''}>
              {t('common.continue')}
            </button>
          </div>
        </form>
      </Screen>
    );
  }

  if (step === 'backup') {
    return (
      <Screen title={t('onboarding.backup.title')}>
        <p className={ui.text}>{t('onboarding.backup.body')}</p>
        <div className={ui.actions}>
          <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => setStep('choose')}>
            {t('onboarding.backup.ack')}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t('onboarding.choose.title')}>
      <div className={ui.actions}>
        <button type="button" className={ui.button} disabled title={t('common.comingSoon')}>
          {t('onboarding.choose.host')}
        </button>
        <button type="button" className={`${ui.button} ${ui.primary}`} onClick={onDone}>
          {t('onboarding.choose.join')}
        </button>
      </div>
      <p className={ui.hint}>{t('onboarding.choose.hostSoon')}</p>
    </Screen>
  );
}

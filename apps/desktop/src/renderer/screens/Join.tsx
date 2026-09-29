import { useReducer, type FormEvent } from 'react';
import { formatFingerprint } from '@ghostlink/shared';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settings.js';
import { buildConnectRequest, initialJoin, joinReducer, type JoinState } from './joinFlow.js';

/**
 * spec §11.1 "Entrar": paste a link, a GL1- code or host:port → confirm the invite
 * or the TOFU fingerprint → nickname (+ password or invite when the server asks) → connect.
 */
export function Join({
  onCancel,
  onJoined,
  start,
}: {
  onCancel: () => void;
  onJoined: (welcome: RendererWelcome) => void;
  /** Where to begin, e.g. at the invite confirmation of a ghostlink:// link (spec §12). */
  start?: JoinState;
}) {
  const t = useT();
  const nickname = useSettingsStore((s) => s.settings?.nickname ?? '');
  const [s, dispatch] = useReducer(joinReducer, nickname, (n) => start ?? initialJoin(n));
  const api = window.ghostlink;

  const submitInput = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = await api.join.parse(s.input);
      const fingerprint = parsed.kind === 'invite' ? formatFingerprint(parsed.invite.serverKeyId) : null;
      dispatch({ type: 'parsed', parsed, fingerprint });
      if (parsed.kind === 'address') {
        const [probe, saved] = await Promise.all([api.join.probe(parsed.address), api.servers.list()]);
        dispatch({ type: 'probed', ...probe, saved });
      }
    } catch (e) {
      dispatch({ type: 'failed', code: errorCodeOf(e) });
    }
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const request = buildConnectRequest(s);
    dispatch({ type: 'submit' });
    try {
      const welcome = await api.join.connect(request);
      dispatch({ type: 'joined' });
      onJoined(welcome);
    } catch (e) {
      dispatch({ type: 'failed', code: errorCodeOf(e) });
    }
  };

  const error = s.error && errorMessage(t, s.error);

  if (s.step === 'input' || s.step === 'probing') {
    const probing = s.step === 'probing';
    return (
      <Screen title={t('join.title')}>
        <form className={ui.form} onSubmit={(e) => void submitInput(e)}>
          <label className={ui.field}>
            <span className={ui.label}>{t('join.input.label')}</span>
            <input
              className={ui.input}
              value={s.input}
              placeholder={t('join.input.placeholder')}
              autoFocus
              spellCheck={false}
              disabled={probing}
              onChange={(e) => dispatch({ type: 'input', value: e.target.value })}
            />
          </label>
          {probing && <p className={ui.hint}>{t('join.probing')}</p>}
          <ErrorLine text={error} />
          <div className={ui.actions}>
            <button type="button" className={ui.button} onClick={onCancel}>
              {t('common.back')}
            </button>
            <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={probing || s.input.trim() === ''}>
              {t('common.continue')}
            </button>
          </div>
        </form>
      </Screen>
    );
  }

  if (s.step === 'confirm' && s.target) {
    const invite = s.source === 'invite';
    const title = invite
      ? s.target.name ? t('join.invite.title', { name: s.target.name }) : t('join.invite.untitled')
      : t('join.tofu.title');
    return (
      <Screen title={title}>
        {invite && s.target.name && <p className={ui.hint}>{t('join.invite.nameHint')}</p>}
        {invite ? (
          <div className={ui.field}>
            <span className={ui.label}>{t('join.invite.addresses')}</span>
            <ul className={ui.list}>
              {s.target.addresses.map((a) => (
                <li key={a} className={ui.hint}>
                  {a}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={ui.text}>{t('join.tofu.body', { address: s.target.addresses[0] ?? '' })}</p>
        )}
        {s.keyConflict && <p className={ui.warning}>{t('join.tofu.keyChanged', { name: s.keyConflict.name })}</p>}
        <div className={ui.field}>
          <span className={ui.label}>{t('join.fingerprint')}</span>
          <p className={ui.fingerprint}>{s.fingerprint}</p>
        </div>
        <div className={ui.actions}>
          <button type="button" className={ui.button} onClick={() => dispatch({ type: 'back' })}>
            {t('common.back')}
          </button>
          <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => dispatch({ type: 'confirm' })}>
            {invite ? t('join.invite.accept') : t('join.tofu.confirm')}
          </button>
        </div>
      </Screen>
    );
  }

  const connecting = s.step === 'connecting' || s.step === 'done';
  return (
    <Screen title={t('join.details.title')}>
      <form className={ui.form} onSubmit={(e) => void connect(e)}>
        <label className={ui.field}>
          <span className={ui.label}>{t('join.details.nickname')}</span>
          <input
            className={ui.input}
            value={s.nickname}
            maxLength={64}
            disabled={connecting}
            onChange={(e) => dispatch({ type: 'field', field: 'nickname', value: e.target.value })}
          />
          {s.suggestion && (
            <button
              type="button"
              className={ui.link}
              onClick={() => dispatch({ type: 'field', field: 'nickname', value: s.suggestion ?? '' })}
            >
              {t('join.details.suggestion', { suggestion: s.suggestion })}
            </button>
          )}
        </label>
        {s.askPassword && (
          <label className={ui.field}>
            <span className={ui.label}>{t('join.details.password')}</span>
            <input
              className={ui.input}
              type="password"
              value={s.password}
              autoFocus
              disabled={connecting}
              onChange={(e) => dispatch({ type: 'field', field: 'password', value: e.target.value })}
            />
          </label>
        )}
        {s.askInvite && (
          <label className={ui.field}>
            <span className={ui.label}>{t('join.details.inviteCode')}</span>
            <input
              className={ui.input}
              value={s.inviteCode}
              autoFocus
              spellCheck={false}
              disabled={connecting}
              onChange={(e) => dispatch({ type: 'field', field: 'inviteCode', value: e.target.value })}
            />
            <span className={ui.hint}>{t('join.details.inviteCodeHint')}</span>
          </label>
        )}
        <ErrorLine text={error} />
        {connecting && <p className={ui.hint}>{t('join.connecting')}</p>}
        <div className={ui.actions}>
          <button type="button" className={ui.button} disabled={connecting} onClick={() => dispatch({ type: 'back' })}>
            {t('common.back')}
          </button>
          <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={connecting || s.nickname.trim() === ''}>
            {t('join.details.connect')}
          </button>
        </div>
      </form>
    </Screen>
  );
}

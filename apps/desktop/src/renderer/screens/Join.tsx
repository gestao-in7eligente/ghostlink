import { useEffect, useReducer, useRef, type FormEvent, type RefObject } from 'react';
import { formatFingerprint } from '@ghostlink/shared';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { requestChannel } from '../features/channelMenu/channelRequest.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { ServerIcon } from '../layout/primitives.js';
import { useSettingsStore } from '../stores/settings.js';
import { buildConnectRequest, initialJoin, joinReducer, savedServerFor, type JoinAction, type JoinState, type JoinTarget } from './joinFlow.js';

/** An invite made with "Convite para o canal" opens that channel with the server's welcome. */
function openInvitedChannel(target: JoinTarget | null): void {
  if (target?.channelId !== undefined) requestChannel(target.serverKeyId, target.channelId);
}

/** The server CLI command that prints the setup code (spec §10); shown verbatim, never translated. */
const SETUP_CODE_COMMAND = 'ghostlink-server setup-code';

/**
 * "Sou o dono deste servidor" (spec §3.3 "Dono"): collapsed until asked for.
 * The code stays in the Join state only and goes into this one join.connect.
 */
function OwnerCode({
  s,
  dispatch,
  inputRef,
  disabled = false,
  autoFocus = false,
  onEnter,
}: {
  s: JoinState;
  dispatch: (action: JoinAction) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Enter in the field, where it is not inside a form. */
  onEnter?: () => void;
}) {
  const t = useT();
  const [hintBefore, hintAfter] = t('join.owner.hint').split('{command}');
  return (
    <>
      <button
        type="button"
        className={ui.link}
        aria-expanded={s.owner}
        disabled={disabled}
        onClick={() => dispatch({ type: 'owner', open: !s.owner })}
      >
        {t('join.owner.toggle')}
      </button>
      {s.owner && (
        <label className={ui.field}>
          <span className={ui.label}>{t('join.owner.label')}</span>
          <input
            ref={inputRef}
            className={`${ui.input} ${ui.mono}`}
            value={s.setupCode}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={s.error === 'BAD_SETUP_CODE'}
            onChange={(e) => dispatch({ type: 'field', field: 'setupCode', value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onEnter) {
                e.preventDefault();
                onEnter();
              }
            }}
          />
          <span className={ui.hint}>
            {hintBefore}
            <code className={ui.mono}>{SETUP_CODE_COMMAND}</code>
            {hintAfter}
          </span>
        </label>
      )}
    </>
  );
}

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
  const setupCodeInput = useRef<HTMLInputElement>(null);

  // A wrong or malformed owner code: put the cursor back in it so it can be fixed and retried.
  useEffect(() => {
    if (s.error !== 'BAD_SETUP_CODE') return;
    setupCodeInput.current?.focus();
    setupCodeInput.current?.select();
  }, [s.error]);

  /**
   * An invite (or address) of a server already joined goes straight in with the saved nickname,
   * instead of asking again (owner request 2026-10-01). False when the server is not saved.
   */
  const enterIfKnown = async (state: JoinState, saved?: SavedServer[]): Promise<boolean> => {
    if (state.step !== 'confirm' || !state.target) return false;
    const known = savedServerFor(saved ?? (await api.servers.list()), state.target.serverKeyId);
    if (!known) return false;
    const next = joinReducer(state, { type: 'known', saved: known });
    if (next.step !== 'connecting') return false;
    dispatch({ type: 'known', saved: known });
    try {
      const welcome = await api.join.connect(buildConnectRequest(next));
      dispatch({ type: 'joined' });
      openInvitedChannel(next.target);
      onJoined(welcome);
    } catch (e) {
      dispatch({ type: 'failed', code: errorCodeOf(e) });
    }
    return true;
  };

  // A ghostlink:// link starts at the invite: go straight in when that server is already saved.
  const startChecked = useRef(false);
  useEffect(() => {
    if (!start || startChecked.current) return;
    startChecked.current = true;
    void enterIfKnown(start).catch(() => undefined);
    // Once, for the state the screen opened with.
  }, []);

  const submitInput = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = await api.join.parse(s.input);
      const fingerprint = parsed.kind === 'invite' ? formatFingerprint(parsed.invite.serverKeyId) : null;
      const parsedAction = { type: 'parsed', parsed, fingerprint } as const;
      dispatch(parsedAction);
      const afterParse = joinReducer(s, parsedAction);
      if (parsed.kind === 'address') {
        const [probe, saved] = await Promise.all([api.join.probe(parsed.address), api.servers.list()]);
        const probedAction = { type: 'probed', ...probe, saved } as const;
        dispatch(probedAction);
        await enterIfKnown(joinReducer(afterParse, probedAction), saved);
      } else {
        await enterIfKnown(afterParse);
      }
    } catch (e) {
      dispatch({ type: 'failed', code: errorCodeOf(e) });
    }
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const next = joinReducer(s, { type: 'submit' });
    dispatch({ type: 'submit' });
    if (next.step !== 'connecting') return; // refused, e.g. a malformed owner code: the error is on screen
    const request = buildConnectRequest(next);
    try {
      const welcome = await api.join.connect(request);
      dispatch({ type: 'joined' });
      openInvitedChannel(next.target);
      onJoined(welcome);
    } catch (e) {
      dispatch({ type: 'failed', code: errorCodeOf(e) });
    }
  };

  const error = s.error && errorMessage(t, s.error);

  if (s.knownName !== null && (s.step === 'connecting' || s.step === 'done')) {
    return (
      <Screen title={t('join.known.title', { name: s.knownName })}>
        <p className={ui.hint}>{t('join.known.text')}</p>
      </Screen>
    );
  }

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
        {/* An invite carries no icon: the server's initials (spec 2026-10-01-icone-do-servidor). */}
        {invite && s.target.name && <ServerIcon name={s.target.name} size={56} />}
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
        <OwnerCode s={s} dispatch={dispatch} inputRef={setupCodeInput} autoFocus onEnter={() => dispatch({ type: 'confirm' })} />
        <ErrorLine text={error} />
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
        {s.owner && <OwnerCode s={s} dispatch={dispatch} inputRef={setupCodeInput} disabled={connecting} />}
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

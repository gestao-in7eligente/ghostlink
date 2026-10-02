import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ExternalLink, TriangleAlert } from 'lucide-react';
import { errorCodeOf, errorMessage, useT } from '../../i18n/index.js';
import { Avatar, ErrorText, Modal, primitives as p } from '../../layout/primitives.js';
import s from '../../layout/settings.module.css';
import { useSettingsStore } from '../../stores/settings.js';
import { AvatarCropModal } from '../profile/AvatarCropModal.js';
import { IMAGE_ACCEPT, usePickedImage } from '../profile/usePickedImage.js';
import { CopyField } from '../server-settings/InviteDialog.js';
import { createBot, setBotPhoto } from './botActions.js';
import { botsGuideUrl } from './botsModel.js';
import b from './bots.module.css';

/** The longest name the field takes (the server keeps 1–32 visible characters, like a nickname). */
const NAME_MAX = 64;
const PREVIEW = 80;

/**
 * The connection code, shown once (bots spec §3): Copiar, the warning that it does not appear
 * again, and the guide. After "Adicionar bot" and after "Gerar novo código".
 */
export function BotCodeDialog({ name, code, photoError = null, onClose }: { name: string; code: string; photoError?: string | null; onClose: () => void }) {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  return (
    <Modal
      title={t('bots.code.title', { name })}
      onClose={onClose}
      size="medium"
      footer={
        <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={onClose}>
          {t('bots.code.done')}
        </button>
      }
    >
      <div className={p.stack} data-bot-code>
        <p className={p.text}>{t('bots.code.body', { name })}</p>
        <CopyField label={t('bots.code.label')} value={code} />
        <p className={b.warning}>
          <TriangleAlert size={16} aria-hidden="true" />
          {t('bots.code.warning')}
        </p>
        {photoError && (
          <p className={p.error} role="alert">
            {t('bots.create.photoFailed', { reason: errorMessage(t, photoError) })}
          </p>
        )}
        <button type="button" className={b.guide} onClick={() => void window.ghostlink.app.openExternal(botsGuideUrl(locale)).catch(() => undefined)}>
          <BookOpen size={16} aria-hidden="true" />
          {t('bots.code.guide')}
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      </div>
    </Modal>
  );
}

/** A photo picked and cropped for the new bot: sent once the bot exists. */
interface BotPhoto {
  bytes: Uint8Array;
  url: string;
}

/**
 * "Adicionar bot" (bots spec §3): a name and, optionally, a photo with the profile photo's crop;
 * then the connection code. The photo goes up after bot.create (it needs the bot's id); if that
 * fails the bot still exists and the code screen says so.
 */
export function AddBotDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const nameId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<BotPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; code: string; photoError: string | null } | null>(null);
  const picking = usePickedImage(t('profile.photo.unreadable'));

  useEffect(() => (photo ? () => URL.revokeObjectURL(photo.url) : undefined), [photo]);

  if (created) return <BotCodeDialog name={created.name} code={created.code} photoError={created.photoError} onClose={onClose} />;

  const trimmed = name.trim();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || trimmed === '') return;
    setBusy(true);
    setError(null);
    try {
      const { bot, connectionToken } = await createBot(trimmed);
      let photoError: string | null = null;
      if (photo) {
        try {
          await setBotPhoto(bot.userId, photo.bytes);
        } catch (err) {
          photoError = errorCodeOf(err);
        }
      }
      setCreated({ name: bot.name, code: connectionToken, photoError });
    } catch (err) {
      setError(errorCodeOf(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title={t('bots.create.title')}
        onClose={() => !busy && onClose()}
        size="medium"
        initialFocus={`#${CSS.escape(nameId)}`}
        footer={
          <>
            <button type="button" className={p.button} onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" form={`${nameId}-form`} className={`${p.button} ${p.buttonPrimary}`} disabled={busy || trimmed === ''}>
              {t('bots.create.submit')}
            </button>
          </>
        }
      >
        <form id={`${nameId}-form`} className={p.stack} onSubmit={(e) => void submit(e)}>
          <div className={s.field}>
            <label htmlFor={nameId} className={s.label}>
              {t('bots.create.name')}
            </label>
            <input
              id={nameId}
              className={s.input}
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            <p className={s.hint}>{t('bots.create.nameHint')}</p>
          </div>
          <div className={s.field}>
            <span className={s.label}>{t('bots.create.photo')}</span>
            <div className={b.photoRow}>
              {photo ? (
                <span className={`${p.avatar} ${p.avatarPhoto}`} style={{ width: PREVIEW, height: PREVIEW }} aria-hidden="true" data-avatar="image">
                  <img className={p.avatarImage} src={photo.url} alt="" draggable={false} />
                </span>
              ) : (
                <Avatar size={PREVIEW} name={trimmed || t('bots.section')} />
              )}
              <div className={b.photoActions}>
                <div className={b.buttons}>
                  <button type="button" className={p.button} onClick={() => input.current?.click()} disabled={busy || picking.opening}>
                    {photo ? t('bots.create.photoChange') : t('bots.create.photoChoose')}
                  </button>
                  {photo && (
                    <button type="button" className={b.plainButton} onClick={() => setPhoto(null)} disabled={busy}>
                      {t('bots.create.photoRemove')}
                    </button>
                  )}
                </div>
                <p className={s.hint}>{t('bots.create.photoHint')}</p>
              </div>
            </div>
            <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => void picking.onFile(e)} data-bot-photo-input />
            {picking.error && ('code' in picking.error ? <ErrorText code={picking.error.code} /> : <p className={p.error} role="alert">{picking.error.text}</p>)}
          </div>
          {error && <ErrorText code={error} />}
        </form>
      </Modal>
      {picking.picked && (
        <AvatarCropModal
          picked={picking.picked}
          onApply={async (bytes) => setPhoto({ bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart])) })}
          onClose={picking.close}
        />
      )}
    </>
  );
}

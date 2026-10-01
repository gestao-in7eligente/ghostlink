import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText, Modal, primitives as p } from '../../layout/primitives.js';
import { browserCodecs } from './browserCodecs.js';
import { CROP_FRAME, MAX_ZOOM, MIN_ZOOM, cropSquare, dragView, imageBox, zoomView, type CropView } from './cropMath.js';
import { AvatarEncodeError, encodeAvatar, type PickedImage } from './encodeAvatar.js';
import x from './profile.module.css';

/** A picked file that decodes, with a blob: URL for the <img> (animated images play there). */
export interface PickedFile extends PickedImage {
  bytes: Uint8Array;
  url: string;
}

const START: CropView = { zoom: 1, x: 0, y: 0 };
/** Arrow keys move the image this far (Shift: four times as far). */
const KEY_STEP = 10;

/**
 * "Editar imagem" (spec 2026-10-01-foto-de-perfil §2): the image in a 320×320 frame under a
 * circular mask; drag (or the arrow keys) to move it, the slider (or the wheel) to zoom from
 * 1× to 5×. Aplicar crops and encodes it (a GIF over 2 MB is refused here) and hands the bytes
 * to `onApply`: my photo, or the server icon (spec 2026-10-01-icone-do-servidor).
 */
export function AvatarCropModal({ picked, onApply, onClose }: { picked: PickedFile; onApply: (bytes: Uint8Array) => Promise<unknown>; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<CropView>(START);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string } | { code: string } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const size = { width: picked.width, height: picked.height };
  const box = imageBox(size, view);

  const close = () => {
    if (!busy) onClose();
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const encoded = await encodeAvatar(picked, cropSquare(size, view), browserCodecs);
      await onApply(encoded.bytes);
      onClose();
    } catch (e) {
      if (e instanceof AvatarEncodeError) setError({ text: t(e.code === 'TOO_LARGE' ? 'profile.crop.tooLarge' : 'profile.photo.unreadable') });
      else setError({ code: errorCodeOf(e) });
      setBusy(false);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (busy || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.id !== e.pointerId) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setView((v) => dragView(size, v, e.clientX - from.x, e.clientY - from.y));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = Object.hasOwn(moves, e.key) ? moves[e.key]! : null;
    if (!move || busy) return;
    e.preventDefault();
    setView((v) => dragView(size, v, move[0], move[1]));
  };

  return (
    <Modal
      title={t('profile.crop.title')}
      onClose={close}
      size="medium"
      initialFocus="[data-crop-zoom]"
      footer={
        <>
          <button type="button" className={`${x.linkButton} ${x.footerStart}`} onClick={() => setView(START)} disabled={busy}>
            {t('profile.crop.reset')}
          </button>
          <button type="button" className={p.button} onClick={close} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonPrimary}`} onClick={() => void apply()} disabled={busy}>
            {busy ? t('profile.crop.applying') : t('profile.crop.apply')}
          </button>
        </>
      }
    >
      <div className={x.crop} aria-busy={busy || undefined}>
        <div
          className={dragging ? `${x.frame} ${x.dragging}` : x.frame}
          style={{ width: CROP_FRAME, height: CROP_FRAME }}
          role="group"
          aria-label={t('profile.crop.frame')}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
          onWheel={(e) => !busy && setView((v) => zoomView(size, v, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))}
        >
          <img className={x.cropImage} src={picked.url} alt="" draggable={false} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
          <span className={x.mask} aria-hidden="true" />
        </div>
        <label className={x.zoomRow}>
          <ImageIcon size={16} aria-hidden="true" />
          <input
            className={x.zoom}
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={view.zoom}
            disabled={busy}
            aria-label={t('profile.crop.zoom')}
            data-crop-zoom
            onChange={(e) => setView((v) => zoomView(size, v, Number(e.target.value)))}
          />
          <ImageIcon size={24} aria-hidden="true" />
        </label>
        {error && ('code' in error ? <ErrorText code={error.code} /> : <p className={p.error} role="alert">{error.text}</p>)}
      </div>
    </Modal>
  );
}

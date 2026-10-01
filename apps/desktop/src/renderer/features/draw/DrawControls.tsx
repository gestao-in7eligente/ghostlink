// The pencil's buttons (spec 2026-10-01-lapis-na-tela-design.md §2): the pencil on a stream's
// bar (next to fullscreen) and on my own share's tile, and "Permitir desenhos" in the LIVE part
// of the voice panel.
import { Pencil } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../i18n/index.js';
import { useVoiceStore } from '../voice/state.js';
import { setAllowDrawing, setPencil, useDrawRuntime } from './runtime.js';
import { canDraw, ownShareAllowed, useDrawStore } from './state.js';
import d from './draw.module.css';

/**
 * The pencil toggle for `sharerId`'s screen. Hidden when I may not draw there (drawing off,
 * old server, not watching). `className`: the look of the bar it sits in.
 */
export function PencilButton({ sharerId, className }: { sharerId: string; className?: string }) {
  useDrawRuntime();
  const t = useT();
  const available = useDrawStore((st) => st.available);
  const off = useDrawStore((st) => st.off);
  const on = useDrawStore((st) => st.pencil === sharerId);
  const allowed = useVoiceStore((v) => canDraw({ available, off }, v, sharerId));
  if (!allowed) return null;
  const label = t(on ? 'draw.pencilStop' : 'draw.pencil');
  return (
    <button
      type="button"
      className={[className ?? d.pencil, on ? d.pencilOn : ''].filter(Boolean).join(' ')}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => setPencil(on ? null : sharerId)}
      data-draw-pencil={sharerId}
    >
      <Pencil size={18} aria-hidden="true" />
    </button>
  );
}

/** The pencil in a corner of my own share's tile on the stage. */
export function OwnTilePencil({ userId }: { userId: string }) {
  return (
    <span className={d.tileTools}>
      <PencilButton sharerId={userId} />
    </span>
  );
}

/** "Permitir desenhos" and the pencil, under my share's preview in the voice panel. */
export function OwnShareDrawControls() {
  useDrawRuntime();
  const t = useT();
  const id = useId();
  const available = useDrawStore((st) => st.available);
  const off = useDrawStore((st) => st.off);
  const allowed = useVoiceStore((v) => ownShareAllowed({ off }, v));
  const self = useVoiceStore((v) => v.selfUserId);
  if (!available || !self) return null;
  return (
    <div className={d.controls} data-draw-controls="">
      <label className={d.allow} htmlFor={id} title={t('draw.allowHint')}>
        <span className={d.allowText}>{t('draw.allow')}</span>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={allowed}
          className={d.switch}
          onClick={() => void setAllowDrawing(!allowed)}
          data-draw-allow={allowed ? 'on' : 'off'}
        >
          <span className={d.knob} />
        </button>
      </label>
      <PencilButton sharerId={self} />
    </div>
  );
}

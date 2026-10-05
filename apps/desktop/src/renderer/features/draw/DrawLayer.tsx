// The canvas over a shared screen (spec 2026-10-01-lapis-na-tela-design.md §2, §3): everyone's
// strokes on that screen, and, while my pencil is on it, drawing with the mouse. It sits inside
// the stream's box (also the fullscreen element) and finds the <video> there, so the strokes stay
// on the picture, the `contain` bars left out.
import { useEffect, useRef } from 'react';
import type { DrawPoint } from '@ghostlink/shared';
import { pencilColor } from './colors.js';
import { containRect, toFrame, type Rect } from './geometry.js';
import { createPainter } from './painter.js';
import { boardOf, createPen, drawName, setPencil, subscribeBoard, useDrawRuntime } from './runtime.js';
import { useDrawStore } from './state.js';
import { useVoiceStore } from '../voice/state.js';
import d from './draw.module.css';

/** Controls of the stream (its bar's buttons and sliders) keep working while the pencil is on. */
const CONTROL = 'button, input, select, textarea, a, label, [role="slider"], [role="menu"]';

/** A pencil cursor in my color, its tip at the hotspot; the outline is the stage's black. */
function pencilCursor(color: string, outline: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${color}" stroke="${outline}" stroke-width="1.5" stroke-linejoin="round">` +
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 22, crosshair`;
}

/** The picture's box inside `box` (CSS pixels): the <video> there with object-fit: contain. */
function pictureRect(box: HTMLElement): Rect | null {
  const video = box.querySelector('video');
  return containRect(box.clientWidth, box.clientHeight, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
}

/**
 * `sharerId`'s strokes over their stream. `interactive`: my pencil can be turned on here (not on
 * the small previews).
 */
export function DrawLayer({ sharerId, interactive = true }: { sharerId: string; interactive?: boolean }) {
  useDrawRuntime();
  const ref = useRef<HTMLCanvasElement>(null);
  const available = useDrawStore((st) => st.available);
  const active = useDrawStore((st) => interactive && st.pencil === sharerId);
  const self = useVoiceStore((v) => v.selfUserId);

  // Paint whenever strokes arrive, and every frame while they fade.
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return;
    const painter = createPainter({
      canvas,
      board: boardOf(sharerId),
      rect: () => pictureRect(box),
      style: (stroke) => ({ color: pencilColor(stroke.userId), label: drawName(stroke.userId) }),
    });
    const off = subscribeBoard(sharerId, painter.kick);
    const observer = new ResizeObserver(painter.kick);
    observer.observe(box);
    painter.kick();
    return () => {
      off();
      observer.disconnect();
      painter.dispose();
    };
  }, [sharerId, available]);

  // Drawing: a drag anywhere on the picture but the stream's own controls; Esc stops (spec §2).
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas?.parentElement;
    if (!active || !canvas || !box || !self) return;
    const pen = createPen(sharerId);
    if (!pen) return;
    let drawing: number | null = null;
    const at = (e: PointerEvent, clamp: boolean): DrawPoint | null => {
      const bounds = box.getBoundingClientRect();
      const rect = pictureRect(box);
      return rect ? toFrame(e.clientX - bounds.left, e.clientY - bounds.top, rect, clamp) : null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || drawing !== null) return;
      if (e.target instanceof Element && e.target !== canvas && e.target.closest(CONTROL)) return;
      const point = at(e, false);
      if (!point) return; // on a black bar
      e.preventDefault();
      e.stopPropagation();
      box.setPointerCapture(e.pointerId);
      drawing = e.pointerId;
      pen.down(point);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== drawing) return;
      for (const each of e.getCoalescedEvents?.() ?? [e]) {
        const point = at(each, true);
        if (point) pen.move(point);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== drawing) return;
      drawing = null;
      pen.up();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPencil(null);
    };
    const outline = getComputedStyle(document.documentElement).getPropertyValue('--bg-stage').trim();
    const cursor = pencilCursor(pencilColor(self), outline);
    canvas.style.cursor = cursor;
    box.style.cursor = cursor;
    box.addEventListener('pointerdown', onDown, true);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
    box.addEventListener('lostpointercapture', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      box.removeEventListener('pointerdown', onDown, true);
      box.removeEventListener('pointermove', onMove);
      box.removeEventListener('pointerup', onUp);
      box.removeEventListener('pointercancel', onUp);
      box.removeEventListener('lostpointercapture', onUp);
      window.removeEventListener('keydown', onKey, true);
      canvas.style.cursor = '';
      box.style.cursor = '';
      if (drawing !== null) pen.up();
    };
  }, [active, sharerId, self]);

  if (!available) return null;
  return <canvas ref={ref} className={active ? `${d.layer} ${d.layerActive}` : d.layer} data-draw-layer={sharerId} data-draw-active={active || undefined} aria-hidden="true" />;
}

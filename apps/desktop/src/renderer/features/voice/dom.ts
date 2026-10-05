// Browser glue for the voice session: where remote audio plays, and the next gesture.
import { createAudioOutlet } from './audioOutlet.js';
import type { AudioOutlet } from './session.js';

/**
 * Remote audio goes into hidden elements created by `track.attach()` (spec §8.4: never a
 * hand-made srcObject), in one hidden box. With webAudioMix the sound is routed through
 * LiveKit's AudioContext.
 */
export function createDomOutlet(): AudioOutlet {
  let box: HTMLDivElement | null = null;
  return createAudioOutlet(() => {
    if (!box || !box.isConnected) {
      box = document.createElement('div');
      box.hidden = true;
      box.dataset.voiceAudio = '';
      document.body.appendChild(box);
    }
    return box;
  });
}

/** Runs `cb` once, on the next pointer press or key press anywhere in the window. */
export function onNextUserGesture(cb: () => void): void {
  const run = () => {
    window.removeEventListener('pointerdown', run, true);
    window.removeEventListener('keydown', run, true);
    cb();
  };
  window.addEventListener('pointerdown', run, true);
  window.addEventListener('keydown', run, true);
}

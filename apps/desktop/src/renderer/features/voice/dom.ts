// Browser glue for the voice session: where remote audio plays, and the next gesture.
import type { RemoteTrack } from 'livekit-client';
import type { AudioOutlet } from './session.js';

/**
 * Remote audio goes into hidden elements created by `track.attach()` (spec §8.4: never a
 * hand-made srcObject). With webAudioMix the sound is routed through LiveKit's AudioContext.
 */
export function createDomOutlet(): AudioOutlet {
  let box: HTMLDivElement | null = null;
  const tracks = new Set<RemoteTrack>();
  const container = () => {
    if (!box || !box.isConnected) {
      box = document.createElement('div');
      box.hidden = true;
      box.dataset.voiceAudio = '';
      document.body.appendChild(box);
    }
    return box;
  };
  return {
    attach(track, userId, source = 'voice') {
      tracks.add(track);
      const el = track.attach();
      if (source === 'screen') {
        // A stream's sound: kept apart from the voices (data-voice-user marks a voice).
        el.dataset.voiceTrack = 'screen';
        el.dataset.screenUser = userId;
      } else {
        el.dataset.voiceTrack = 'remote';
        el.dataset.voiceUser = userId;
      }
      container().appendChild(el);
    },
    detach(track) {
      tracks.delete(track);
      for (const el of track.detach()) el.remove();
    },
    detachAll() {
      for (const track of tracks) for (const el of track.detach()) el.remove();
      tracks.clear();
    },
  };
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

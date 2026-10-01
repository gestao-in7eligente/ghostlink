// Where remote audio plays, without touching the DOM itself (dom.ts gives it the container),
// so the bookkeeping is tested in Node.
import type { RemoteTrack } from 'livekit-client';
import type { AudioOutlet } from './session.js';

type MediaElement = ReturnType<RemoteTrack['attach']>;

/**
 * Remote audio goes into elements created by `track.attach()` (spec §8.4: never a hand-made
 * srcObject), appended to `container()`. The outlet remembers each element it created:
 * LiveKit detaches an unsubscribed track itself before TrackUnsubscribed fires, so
 * `track.detach()` would no longer name the element, and it would stay in the page.
 */
export function createAudioOutlet(container: () => { appendChild(el: MediaElement): unknown }): AudioOutlet {
  const elements = new Map<RemoteTrack, MediaElement>();
  const remove = (track: RemoteTrack) => {
    const el = elements.get(track);
    if (!el) return;
    elements.delete(track);
    track.detach(el);
    el.remove();
  };
  return {
    attach(track, userId, source = 'voice') {
      remove(track);
      const el = track.attach();
      if (source === 'screen') {
        // A stream's sound: kept apart from the voices (data-voice-user marks a voice).
        el.dataset.voiceTrack = 'screen';
        el.dataset.screenUser = userId;
      } else {
        el.dataset.voiceTrack = 'remote';
        el.dataset.voiceUser = userId;
      }
      elements.set(track, el);
      container().appendChild(el);
    },
    detach: remove,
    detachAll() {
      for (const track of [...elements.keys()]) remove(track);
    },
  };
}

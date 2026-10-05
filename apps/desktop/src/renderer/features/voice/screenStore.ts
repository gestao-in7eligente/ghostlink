// UI-side state of screen sharing that is not plain data: the open picker (with the promise
// the publishing flow waits on) and the LiveKit video tracks the stage and panel attach.
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import { create } from 'zustand';
import type { ScreenSource } from '../../../shared/screenTypes.js';
import type { ScreenSelection } from './screenShare.js';
import type { VideoOutlet } from './session.js';

export interface PickerRequest {
  /** Tells one opening of the picker from the next. */
  id: number;
  /** Resolves when main listed them (up to a few seconds on Windows). */
  sources: Promise<ScreenSource[]>;
  /** Transmitir (a selection) or Cancelar (null). Closes the picker. */
  answer(selection: ScreenSelection | null): void;
}

/** The screen picker: open while a request is pending. */
export const useScreenPicker = create<{ request: PickerRequest | null }>()(() => ({ request: null }));

let nextId = 1;

/** The flow's `pick`: opens the picker and waits for its answer. A newer request cancels an older one. */
export function pickScreen(sources: Promise<ScreenSource[]>): Promise<ScreenSelection | null> {
  return new Promise((resolve) => {
    cancelScreenPicker();
    const request: PickerRequest = {
      id: nextId++,
      sources,
      answer: (selection) => {
        if (useScreenPicker.getState().request === request) useScreenPicker.setState({ request: null });
        resolve(selection);
      },
    };
    useScreenPicker.setState({ request });
  });
}

/** Closes the picker as cancelled (the call ended under it). */
export function cancelScreenPicker(): void {
  useScreenPicker.getState().request?.answer(null);
}

interface ScreenTracks {
  /** Watched people's screens, by user id. */
  remote: Readonly<Record<string, RemoteTrack>>;
  /** My own share's picture (the self-preview). */
  local: LocalVideoTrack | null;
}

/** The video tracks the voice UI attaches (never through srcObject). */
export const useScreenTracks = create<ScreenTracks>()(() => ({ remote: {}, local: null }));

/** The session's video outlet: the tracks go into useScreenTracks. */
export function createScreenOutlet(): VideoOutlet {
  return {
    remote(userId, track) {
      useScreenTracks.setState((s) => {
        const remote = { ...s.remote };
        if (track) remote[userId] = track;
        else delete remote[userId];
        return { remote };
      });
    },
    local(track) {
      useScreenTracks.setState({ local: track });
    },
    clear() {
      useScreenTracks.setState({ remote: {}, local: null });
    },
  };
}

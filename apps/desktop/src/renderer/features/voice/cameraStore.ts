// The camera tracks the voice stage attaches: everyone's received camera by user id, and my
// own (the mirrored self-view). Never through srcObject (spec §8.4): the tiles call attach().
import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import { create } from 'zustand';
import type { VideoOutlet } from './session.js';

interface CameraTracks {
  /** Received cameras, by user id. */
  remote: Readonly<Record<string, RemoteTrack>>;
  /** My own camera while it is on. */
  local: LocalVideoTrack | null;
}

export const useCameraTracks = create<CameraTracks>()(() => ({ remote: {}, local: null }));

/** The session's camera outlet: the tracks go into useCameraTracks. */
export function createCameraOutlet(): VideoOutlet {
  return {
    remote(userId, track) {
      useCameraTracks.setState((s) => {
        const remote = { ...s.remote };
        if (track) remote[userId] = track;
        else delete remote[userId];
        return { remote };
      });
    },
    local(track) {
      useCameraTracks.setState({ local: track });
    },
    clear() {
      useCameraTracks.setState({ remote: {}, local: null });
    },
  };
}

/** The camera to show in `userId`'s tile: my own local track for me, the received one for others. */
export function useCameraTrack(userId: string, self: boolean): RemoteTrack | LocalVideoTrack | null {
  return useCameraTracks((s) => (self ? s.local : Object.hasOwn(s.remote, userId) ? s.remote[userId]! : null));
}

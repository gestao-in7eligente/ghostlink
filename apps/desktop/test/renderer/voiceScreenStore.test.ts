import type { LocalVideoTrack, RemoteTrack } from 'livekit-client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ScreenSelection } from '../../src/renderer/features/voice/screenShare.js';
import { cancelScreenPicker, createScreenOutlet, pickScreen, useScreenPicker, useScreenTracks } from '../../src/renderer/features/voice/screenStore.js';

const BIA = 'b'.repeat(32);
const selection: ScreenSelection = { sourceId: 'screen:1:0', name: 'Tela 1', quality: '1080p30', content: 'motion', audio: true };

beforeEach(() => {
  useScreenPicker.setState({ request: null });
  useScreenTracks.setState({ remote: {}, local: null });
});

describe('the picker request (the flow waits on it)', () => {
  it('opens with the sources still loading; Transmitir answers and closes it', async () => {
    const sources = Promise.resolve([]);
    const picked = pickScreen(sources);
    const request = useScreenPicker.getState().request!;
    expect(request.sources).toBe(sources);
    request.answer(selection);
    expect(await picked).toEqual(selection);
    expect(useScreenPicker.getState().request).toBeNull();
  });

  it('Cancelar answers null; a newer request cancels an older one', async () => {
    const first = pickScreen(Promise.resolve([]));
    const second = pickScreen(Promise.resolve([]));
    expect(await first).toBeNull();
    const request = useScreenPicker.getState().request!;
    request.answer(null);
    expect(await second).toBeNull();
    expect(useScreenPicker.getState().request).toBeNull();
  });

  it('each opening is a new request; cancelScreenPicker (the call ended) answers null', async () => {
    const first = pickScreen(Promise.resolve([]));
    const id = useScreenPicker.getState().request!.id;
    cancelScreenPicker();
    expect(await first).toBeNull();
    expect(useScreenPicker.getState().request).toBeNull();
    void pickScreen(Promise.resolve([]));
    expect(useScreenPicker.getState().request!.id).not.toBe(id);
    cancelScreenPicker();
    cancelScreenPicker(); // nothing open: nothing happens
  });

  it('an old request answering late does not close a newer one', async () => {
    void pickScreen(Promise.resolve([]));
    const old = useScreenPicker.getState().request!;
    void pickScreen(Promise.resolve([]));
    const current = useScreenPicker.getState().request;
    old.answer(selection);
    expect(useScreenPicker.getState().request).toBe(current);
  });
});

describe('the video outlet', () => {
  it('keeps watched screens by user and my own preview, and clears both when the call ends', () => {
    const outlet = createScreenOutlet();
    const track = { kind: 'video' } as unknown as RemoteTrack;
    const mine = { kind: 'video' } as unknown as LocalVideoTrack;
    outlet.remote(BIA, track);
    outlet.local(mine);
    expect(useScreenTracks.getState()).toEqual({ remote: { [BIA]: track }, local: mine });
    outlet.remote(BIA, null);
    expect(useScreenTracks.getState().remote).toEqual({});
    outlet.remote(BIA, track);
    outlet.clear();
    expect(useScreenTracks.getState()).toEqual({ remote: {}, local: null });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SCREEN_CHOICE_TTL_MS } from '../../src/shared/screenTypes.js';
import { ScreenPicker, type CapturerSource, type DisplayMediaRequest, type DisplayMediaStreams } from '../../src/main/screenPicker.js';

const APP = 'app://ghostlink';
/** BrowserWindow.getMediaSourceId() of GhostLink's own window, as measured: the "1" marks this process. */
const OWN = 'window:4196598:1';

function image(png: string | null) {
  return { isEmpty: () => png === null, toDataURL: () => `data:image/png;base64,${png ?? ''}` };
}

// Out of order on purpose: the picker puts screens first.
const SOURCES: CapturerSource[] = [
  { id: 'window:133240:0', name: 'Navegador', thumbnail: image('bmF2'), appIcon: image('aWNvbg') },
  { id: 'screen:0:0', name: 'Tela cheia', thumbnail: image('dGVsYQ'), appIcon: null },
  { id: OWN, name: 'GhostLink', thumbnail: image('Z2hvc3Q'), appIcon: image('Z2hvc3Q') },
  { id: 'window:67284:0', name: 'Jogo', thumbnail: image(null), appIcon: image(null) },
  { id: 'screen:1:0', name: 'Tela 2', thumbnail: image('dGVsYTI'), appIcon: null },
  { id: 'tab:1:2', name: 'Not a desktop source', thumbnail: image('eA'), appIcon: null },
];

/** As Electron 44 sends it: the origin is serialized with a trailing slash. */
const REQUEST: DisplayMediaRequest = { securityOrigin: 'app://ghostlink/', audioRequested: true };

function setup(sources: CapturerSource[] = SOURCES) {
  let now = 50_000;
  const getSources = vi.fn(async () => sources);
  const picker = new ScreenPicker({ getSources, now: () => now, appOrigin: APP, ownMediaSourceId: () => OWN });
  return { picker, getSources, advance: (ms: number) => void (now += ms) };
}

/** Runs the handler and checks the callback ran exactly once. */
async function answer(picker: ScreenPicker, request: DisplayMediaRequest = REQUEST): Promise<DisplayMediaStreams> {
  const callback = vi.fn();
  await picker.handleRequest(request, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0]![0] as DisplayMediaStreams;
}

describe('ScreenPicker.listSources (spec §3)', () => {
  it('asks desktopCapturer for 320×180 thumbnails and window icons', async () => {
    const { picker, getSources } = setup();
    await picker.listSources();
    expect(getSources).toHaveBeenCalledWith({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  });

  it('lists screens first, then windows, without GhostLink itself; empty images become null', async () => {
    const { picker } = setup();
    expect(await picker.listSources()).toEqual([
      { id: 'screen:0:0', name: 'Tela cheia', kind: 'screen', thumbnail: 'data:image/png;base64,dGVsYQ', icon: null },
      { id: 'screen:1:0', name: 'Tela 2', kind: 'screen', thumbnail: 'data:image/png;base64,dGVsYTI', icon: null },
      { id: 'window:133240:0', name: 'Navegador', kind: 'window', thumbnail: 'data:image/png;base64,bmF2', icon: 'data:image/png;base64,aWNvbg' },
      { id: 'window:67284:0', name: 'Jogo', kind: 'window', thumbnail: null, icon: null },
    ]);
  });
});

describe('ScreenPicker.handleRequest (spec §3)', () => {
  it('hands over the chosen source, re-listed without thumbnails', async () => {
    const { picker, getSources } = setup();
    picker.choose({ sourceId: 'window:133240:0', audio: false });
    expect(await answer(picker)).toEqual({ video: { id: 'window:133240:0', name: 'Navegador' } });
    expect(getSources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  });

  it.each<[string, boolean, boolean, DisplayMediaStreams]>([
    ['both ask for sound', true, true, { video: { id: 'screen:0:0', name: 'Tela cheia' }, audio: 'loopback' }],
    ['only the choice asks for sound', true, false, { video: { id: 'screen:0:0', name: 'Tela cheia' } }],
    ['only the request asks for sound', false, true, { video: { id: 'screen:0:0', name: 'Tela cheia' } }],
    ['neither asks for sound', false, false, { video: { id: 'screen:0:0', name: 'Tela cheia' } }],
  ])('adds the PC sound only when both ask for it: %s', async (_label, choiceAudio, audioRequested, expected) => {
    const { picker } = setup();
    picker.choose({ sourceId: 'screen:0:0', audio: choiceAudio });
    expect(await answer(picker, { ...REQUEST, audioRequested })).toEqual(expected);
  });

  it('keeps the choice for 10 s and no longer', async () => {
    const { picker, advance } = setup();
    picker.choose({ sourceId: 'screen:0:0', audio: true });
    advance(SCREEN_CHOICE_TTL_MS);
    expect(await answer(picker)).toMatchObject({ video: { id: 'screen:0:0' } });

    picker.choose({ sourceId: 'screen:0:0', audio: true });
    advance(SCREEN_CHOICE_TTL_MS + 1);
    expect(await answer(picker)).toEqual({});
  });

  it('uses a choice once', async () => {
    const { picker, getSources } = setup();
    picker.choose({ sourceId: 'screen:0:0', audio: true });
    expect(await answer(picker)).toMatchObject({ video: { id: 'screen:0:0' } });
    expect(await answer(picker)).toEqual({});
    expect(getSources).toHaveBeenCalledTimes(1);
  });

  it('a new choice replaces the earlier one', async () => {
    const { picker } = setup();
    picker.choose({ sourceId: 'screen:0:0', audio: true });
    picker.choose({ sourceId: 'window:67284:0', audio: false });
    expect(await answer(picker)).toEqual({ video: { id: 'window:67284:0', name: 'Jogo' } });
  });

  it('refuses without a choice, before listing anything', async () => {
    const { picker, getSources } = setup();
    expect(await answer(picker)).toEqual({});
    expect(getSources).not.toHaveBeenCalled();
  });

  it('refuses a source that vanished since the choice, and GhostLink itself', async () => {
    const { picker } = setup();
    picker.choose({ sourceId: 'window:999999:0', audio: true });
    expect(await answer(picker)).toEqual({});
    picker.choose({ sourceId: OWN, audio: true });
    expect(await answer(picker)).toEqual({});
  });

  it.each(['https://evil.example/', 'app://ghostlink.evil/', 'http://localhost:5173/', 'null', ''])(
    'refuses another origin (%j) and drops the choice',
    async (securityOrigin) => {
      const { picker, getSources } = setup();
      picker.choose({ sourceId: 'screen:0:0', audio: true });
      expect(await answer(picker, { ...REQUEST, securityOrigin })).toEqual({});
      expect(await answer(picker)).toEqual({});
      expect(getSources).not.toHaveBeenCalled();
    },
  );

  it('answers the dev server origin in development', async () => {
    const getSources = vi.fn(async () => SOURCES);
    const picker = new ScreenPicker({ getSources, now: () => 0, appOrigin: 'http://localhost:5173', ownMediaSourceId: () => null });
    picker.choose({ sourceId: 'screen:0:0', audio: false });
    expect(await answer(picker, { ...REQUEST, securityOrigin: 'http://localhost:5173/' })).toEqual({ video: { id: 'screen:0:0', name: 'Tela cheia' } });
  });

  it('refuses when listing fails', async () => {
    const { picker, getSources } = setup();
    getSources.mockRejectedValueOnce(new Error('capturer gone'));
    picker.choose({ sourceId: 'screen:0:0', audio: true });
    expect(await answer(picker)).toEqual({});
  });

  it("survives Electron 44 throwing after it refused (callback({}) with video requested)", async () => {
    const { picker } = setup();
    const callback = vi.fn(() => {
      throw new TypeError('Video was requested, but no video stream was provided');
    });
    await expect(picker.handleRequest(REQUEST, callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({});
  });
});

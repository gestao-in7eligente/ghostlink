# Screen Sharing Implementation Plan

> **For agentic workers:** two parallel tracks meeting at a contract (the owner wants speed: one review per milestone). Each track works test-first and ends with `lint`, `typecheck` and its tests green.

**Goal:** in a server's voice channel, a person shares a screen or a window with the PC's sound (without GhostLink's own audio), and the others watch it on demand.

**Spec:** `docs/superpowers/specs/2026-10-01-transmitir-tela-design.md`. The main spec's §8.4 (media in the client) and §12 (Electron security) still apply.

**Branch:** `v0.2-screen` (from `main`), in the worktree `.claude/worktrees/screen`.

## The contract (committed)

- `apps/desktop/src/shared/screenTypes.ts`: `ScreenSource`, `ScreenChoice`, `ScreenApi`, `SCREEN_SOURCE_ID`, `SCREEN_CHOICE_TTL_MS`.
- `apps/desktop/src/shared/ipcTypes.ts`: `IPC.screenSources`, `IPC.screenChoose`, `GhostlinkApi.screen`.
- `apps/desktop/src/preload/index.ts`: `window.ghostlink.screen`.
- No new error codes: a refused capture reaches the renderer as `AbortError` from `getDisplayMedia`, and bad arguments as `BAD_REQUEST`.

Facts measured on 2026-10-01 (Electron 44.4.5, Windows 11), which both tracks rely on:
- `callback({ video: source, audio: 'loopback' })` in `setDisplayMediaRequestHandler` captures the whole system sound, **including** GhostLink's own playback.
- With `getDisplayMedia({ audio: { restrictOwnAudio: true, … } })` in the renderer, the same handler answer yields a track whose `getSettings().deviceId === 'loopbackWithoutChrome'`, and GhostLink's audio is excluded.

## Track A: capture (main process)

**Owns:** `apps/desktop/src/main/screenPicker.ts` (new), `apps/desktop/src/main/screenIpc.ts` (new), the wiring in `main/ipc.ts` and `main/index.ts`, and tests `apps/desktop/test/main/screenPicker.test.ts` and `screenIpc.test.ts`.

| Unit | Responsibility |
|---|---|
| `screenPicker.ts` | `ScreenPicker` class, Electron-free, with these dependencies injected: `getSources(opts)` (`desktopCapturer.getSources`), a clock, and `appOrigin`. |
| `listSources()` | Returns `ScreenSource[]`: kind from the id prefix, thumbnail and icon as PNG data URLs, null when empty (`nativeImage.isEmpty()`). Screens come first, then windows. GhostLink's own window is left out (its `getMediaSourceId()` is injected). |
| `choose(choice)` | Remembers `{ sourceId, audio, at }`, replacing any earlier choice. |
| `handleRequest(request, callback)` | The body of `setDisplayMediaRequestHandler`. It refuses with `callback({})` when the request's origin is not the app's, when there is no choice or it is older than `SCREEN_CHOICE_TTL_MS`, or when the chosen source is no longer listed. Otherwise it answers `{ video: source }`, plus `audio: 'loopback'` when the choice asked for sound **and** `request.audioRequested`. The choice is consumed either way, and the callback is called exactly once, also when listing throws. |
| `screenIpc.ts` | Strict zod schemas: `screen.sources: []` and `screen.choose: [strictObject({ sourceId: regex SCREEN_SOURCE_ID, audio: boolean })]`. Handlers follow the `hostIpc.ts` pattern. |
| `index.ts` | Creates the picker after `app.whenReady()`, registers `session.defaultSession.setDisplayMediaRequestHandler((req, cb) => picker.handleRequest(req, cb))` (no `useSystemPicker`), and passes the picker to the IPC layer. |

**Tests**
- Sources are mapped and ordered, and empty thumbnails and icons become null. GhostLink's own window is excluded.
- The choice expires after 10 s (injected clock) and is consumed after one use.
- The handler refuses with no choice, an expired choice, a vanished source or a foreign origin, and still calls the callback once.
- `audio: 'loopback'` is sent only when both the choice and the request ask for it.
- A throwing `getSources` still answers `{}`.
- IPC: a bad `sourceId`, extra keys or a non-boolean `audio` are refused.

## Track B: publishing and watching (renderer)

**Owns:** `apps/desktop/src/renderer/features/voice/**` (except files Track A names), `renderer/i18n/voice.*.ts`, tests under `apps/desktop/test/renderer/` (new or extended `voice*` tests), and `apps/desktop/test/e2e/screen.e2e.ts` (new).

| Unit | Responsibility |
|---|---|
| `screenShare.ts` | Pure helpers plus the publishing flow. |
| `screenPresets` | 720p30 = `ScreenSharePresets.h720fps30`, 1080p30 = `ScreenSharePresets.h1080fps30`, 1080p60 = `new VideoPreset(1920, 1080, 8_000_000, 60)`. Simulcast: one lower layer (360p for 720p, 720p for the 1080 presets). |
| `screenCaptureOptions(quality, content, audio)` | The `createLocalScreenTracks` options: resolution from the preset, and `contentHint` `'detail'` or `'motion'`. The audio constraints are `{ restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false }` (cast where the LiveKit types lack the field) or `false`. |
| `keepScreenAudio(track)` | True only when `getSettings().deviceId === 'loopbackWithoutChrome'`. Otherwise the caller stops the audio track and shows the "Windows 11" notice. |
| `startScreenShare(...)` | Lists sources (IPC), waits for the picker's choice, calls `screen.choose`, creates the tracks, checks the audio, and publishes. Video goes as `Track.Source.ScreenShare` with `screenShareEncoding` and `screenShareSimulcastLayers`, plus `degradationPreference: 'maintain-framerate'` for `motion`. Sound goes as `Track.Source.ScreenShareAudio`, stereo, without DTX or RED. |
| `stopScreenShare()` | Unpublishes and stops both tracks. A track ending by itself (the window closed) stops the share as well. |
| `session.ts` | Watching. `watch(userId)` and `unwatch(userId)` call `setSubscribed` on that person's `ScreenShare` and `ScreenShareAudio` publications. The watched set lives in the voice store, and is re-applied on `TrackPublished` and after a reconnect. Microphones stay as they are. Stream volume goes through the existing per-user volume machinery, under its own key (`screen:<userId>`). |
| `state.ts` | Adds `sharing` (my share: `null` or `{ quality, content, audio }`) and `watching: string[]`. "Who is live" comes from `VoiceParticipant.screen` (`voice.state`). |
| UI | **Picker modal:** tabs Telas and Janelas; thumbnails, icons and names; loading state; quality and content selects; "Transmitir o som do PC" (on by default); Transmitir and Cancelar. **Voice panel:** "Transmitir tela" (off, with a title explaining why, without VIDEO), and while live the "AO VIVO" badge, a small self-preview and "Parar transmissão". **Participant list:** an "AO VIVO" badge. **Voice stage:** a tile per live person with "Assistir"; watching shows the video large (`track.attach`, never `srcObject`), with fullscreen, stream volume and "Parar de assistir"; several streams form a grid, and a click focuses one. |
| i18n | pt-BR and en for every text, including the notices: "O som do PC precisa do Windows 11. Transmitindo só a imagem." and "Não foi possível capturar essa tela ou janela. Tente de novo." |

**Permission:** the button checks `VIDEO` in the channel through the voice directory's permission lookup, the same one used for `SPEAK`.

**Tests**
- Pure tests for the presets and capture options, the audio-keep decision, and the watched-set reducer and its re-application.
- Session tests with the existing LiveKit fakes: watch subscribes both publications, unwatch unsubscribes them, and a `TrackPublished` for a watched user subscribes it.
- **e2e** `screen.e2e.ts`, built on the v0.1 e2e harness:
  1. Ana hosts, Bia joins, and both enter voice.
  2. Ana opens the picker and picks the first screen.
  3. Bia sees "AO VIVO", clicks Assistir, and a `<video>` reaches `readyState >= 2` with `videoWidth > 0`.
  4. Bia stops watching and the video element goes away.
  5. Ana stops and the badge disappears for Bia.
- Fake devices cannot exercise the PC's sound, which goes to the manual checklist.

## Integration

1. `npm run lint`, `npm run typecheck`, `npm test` and `npm run test:e2e`.
2. Manual check on this PC: share a YouTube video while in a call. The viewer hears the video, not the call. Repeat with 1080p60.
3. Add the screen-sharing items to `docs/checklist-teste.md` (spec §10).

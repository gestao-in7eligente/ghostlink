// Screen sharing, the capture side (spec 2026-10-01-transmitir-tela-design.md §3): main lists the
// sources for the renderer's own picker, keeps the choice for a few seconds, and answers the
// display-media request with exactly that source. Electron-free: index.ts injects desktopCapturer,
// the clock and the main window's media source id.
import { SCREEN_CHOICE_TTL_MS, SCREEN_SOURCE_ID, type ScreenChoice, type ScreenSource, type ScreenSourceKind } from '../shared/screenTypes.js';
import { originOf } from './security.js';

/** The part of Electron's NativeImage the picker uses. */
export interface ImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

/** The part of Electron's DesktopCapturerSource the picker uses. */
export interface CapturerSource {
  id: string;
  name: string;
  thumbnail: ImageLike;
  /** null for screens (and for windows when icons were not asked for). */
  appIcon: ImageLike | null;
}

/** desktopCapturer.getSources' options. */
export interface CapturerOptions {
  types: ScreenSourceKind[];
  thumbnailSize: { width: number; height: number };
  fetchWindowIcons?: boolean;
}

/** The part of Electron's DisplayMediaRequestHandlerHandlerRequest the handler reads. */
export interface DisplayMediaRequest {
  /** Serialized with a trailing slash ("app://ghostlink/"), hence originOf. */
  securityOrigin: string;
  audioRequested: boolean;
}

/** Electron's Streams, narrowed to what screen sharing grants; {} refuses. */
export interface DisplayMediaStreams {
  video?: { id: string; name: string };
  audio?: 'loopback';
}

export interface ScreenPickerDeps {
  getSources(opts: CapturerOptions): Promise<CapturerSource[]>;
  now(): number;
  /** app://ghostlink, or the dev server origin in development. */
  appOrigin: string;
  /** GhostLink's own windows (BrowserWindow.getMediaSourceId(): the main window, the notification cards), left out of the list. */
  ownMediaSourceIds(): readonly string[];
  /** usesPortalCapture(): the portal, not our list, shows the screens. */
  portalCapture?: boolean;
}

/**
 * Wayland has no enumerable screens: Chromium asks the xdg-desktop-portal, whose own dialog lets
 * the person pick, and desktopCapturer.getSources then answers with that single stream (id
 * "window:1:0:s", empty name; measured on Electron 44 / KDE). So the picker offers one placeholder
 * source, and the capture request is what opens the portal dialog (one dialog per share).
 */
export const PORTAL_SOURCE_ID = 'screen:0:0';
export const PORTAL_SOURCE_NAME = 'Screen or window (system dialog)';

/** True when Chromium will capture through the portal: Wayland session, not forced onto X11. */
export function usesPortalCapture(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform !== 'linux' || env.ELECTRON_OZONE_PLATFORM_HINT === 'x11') return false;
  return env.XDG_SESSION_TYPE === 'wayland' || (env.WAYLAND_DISPLAY ?? '') !== '';
}

/** A choice and when it was made. */
type HeldChoice = ScreenChoice & { at: number };

const LIST_OPTIONS: CapturerOptions = { types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true };

export class ScreenPicker {
  private choice: HeldChoice | null = null;

  constructor(private readonly deps: ScreenPickerDeps) {}

  /** For the picker: screens first, then windows, each in desktopCapturer's order. */
  async listSources(): Promise<ScreenSource[]> {
    // Asking desktopCapturer here would open the portal dialog before the person set quality and sound.
    if (this.deps.portalCapture) return [{ id: PORTAL_SOURCE_ID, name: PORTAL_SOURCE_NAME, kind: 'screen', thumbnail: null, icon: null }];
    const sources = this.capturable(await this.deps.getSources(LIST_OPTIONS)).map(({ source, kind }) => ({
      id: source.id,
      name: source.name,
      kind,
      thumbnail: dataUrl(source.thumbnail),
      icon: dataUrl(source.appIcon),
    }));
    return [...sources.filter((s) => s.kind === 'screen'), ...sources.filter((s) => s.kind === 'window')];
  }

  /** Kept for the next capture request, replacing any earlier choice. */
  choose(choice: ScreenChoice): void {
    this.choice = { sourceId: choice.sourceId, audio: choice.audio, at: this.deps.now() };
  }

  /**
   * The body of session.setDisplayMediaRequestHandler. Calls `callback` exactly once: with the
   * chosen source, or with {} to refuse (the renderer's getDisplayMedia then fails with AbortError).
   */
  async handleRequest(request: DisplayMediaRequest, callback: (streams: DisplayMediaStreams) => void): Promise<void> {
    // Taken before any await, so two requests can never share one choice.
    const choice = this.choice;
    this.choice = null;
    let streams: DisplayMediaStreams = {};
    try {
      streams = await this.answer(request, choice);
    } catch {
      // Listing failed: refuse.
    }
    if (streams.video) {
      callback(streams);
      return;
    }
    try {
      callback({});
    } catch {
      // Measured on Electron 44: with video requested, callback({}) rejects the capture
      // (AbortError in the renderer) and then throws "Video was requested, but no video stream was provided".
    }
  }

  private async answer(request: DisplayMediaRequest, choice: HeldChoice | null): Promise<DisplayMediaStreams> {
    if (originOf(request.securityOrigin) !== this.deps.appOrigin) return {};
    if (!choice || this.deps.now() - choice.at > SCREEN_CHOICE_TTL_MS) return {};
    const kind = sourceKind(choice.sourceId);
    if (!kind) return {};
    if (this.deps.portalCapture) return this.portalAnswer(request, choice);
    // A window closed since the choice is refused here (AbortError) instead of failing to start
    // later (NotReadableError). Without thumbnails, which are the slow part.
    const listed = this.capturable(await this.deps.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 } }));
    const source = listed.find((s) => s.source.id === choice.sourceId)?.source;
    if (!source) return {};
    const video = { id: source.id, name: source.name };
    return choice.audio && request.audioRequested ? { video, audio: 'loopback' } : { video };
  }

  /** Opens the portal dialog; its single stream is the person's choice. Nothing chosen there: refused. */
  private async portalAnswer(request: DisplayMediaRequest, choice: HeldChoice): Promise<DisplayMediaStreams> {
    if (choice.sourceId !== PORTAL_SOURCE_ID) return {};
    const [source] = await this.deps.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!source) return {};
    const video = { id: source.id, name: source.name || PORTAL_SOURCE_NAME };
    return choice.audio && request.audioRequested ? { video, audio: 'loopback' } : { video };
  }

  /** Screens and windows with a well-formed id, without GhostLink's own windows. */
  private capturable(sources: CapturerSource[]): { source: CapturerSource; kind: ScreenSourceKind }[] {
    const own = this.deps.ownMediaSourceIds();
    return sources.flatMap((source) => {
      const kind = sourceKind(source.id);
      return kind && !own.includes(source.id) ? [{ source, kind }] : [];
    });
  }
}

function sourceKind(id: string): ScreenSourceKind | null {
  return (SCREEN_SOURCE_ID.exec(id)?.[1] as ScreenSourceKind | undefined) ?? null;
}

function dataUrl(image: ImageLike | null): string | null {
  return image && !image.isEmpty() ? image.toDataURL() : null;
}

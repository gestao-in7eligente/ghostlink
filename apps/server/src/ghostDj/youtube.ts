import { GHOST_DJ_LIMITS } from '@ghostlink/shared';

/**
 * What `/play busca` asks for (spec §1): a YouTube video or playlist link, rebuilt from its id
 * alone, or a search (yt-dlp's `ytsearch1:`, the first result). Nothing the user typed reaches
 * yt-dlp but an id that matches its pattern or the search text after `ytsearch1:`, always as the
 * last argument after `--` (ytdlp.ts), so it can never be read as an option or another site.
 */
export type PlayTarget =
  | { kind: 'video'; id: string; url: string }
  | { kind: 'playlist'; id: string; url: string }
  | { kind: 'search'; query: string; url: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
/** Paths whose next segment is a video id: /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>. */
const ID_PATHS = new Set(['shorts', 'live', 'embed', 'v']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;

export const videoUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;
export const playlistUrl = (id: string): string => `https://www.youtube.com/playlist?list=${id}`;

/** True when the text is meant as a link (then it must be a YouTube one). */
function looksLikeLink(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(text);
}

/**
 * Reads `/play busca`: null when it is empty or a link that is not a YouTube video or playlist
 * (another site, a channel page, a link with a port or credentials). A `watch?v=…&list=…` link
 * plays that video; a `/playlist?list=…` link, the playlist.
 */
export function parsePlayQuery(input: string): PlayTarget | null {
  const text = input.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > GHOST_DJ_LIMITS.queryMax) return null;
  if (!looksLikeLink(text)) return { kind: 'search', query: text, url: `ytsearch1:${text}` };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const video = (id: string | null | undefined): PlayTarget | null => (id && VIDEO_ID.test(id) ? { kind: 'video', id, url: videoUrl(id) } : null);
  if (SHORT_HOSTS.has(host)) return segments.length === 1 ? video(segments[0]) : null;
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (segments.length === 1 && segments[0] === 'watch') return video(url.searchParams.get('v'));
  if (segments.length === 2 && ID_PATHS.has(segments[0]!)) return video(segments[1]);
  if (segments.length === 1 && segments[0] === 'playlist') {
    const id = url.searchParams.get('list');
    return id && PLAYLIST_ID.test(id) ? { kind: 'playlist', id, url: playlistUrl(id) } : null;
  }
  return null;
}

/** A video id yt-dlp reported, or null when it does not look like one. */
export function videoIdOf(value: unknown): string | null {
  return typeof value === 'string' && VIDEO_ID.test(value) ? value : null;
}

/** What the app's chat markdown lets a backslash escape (renderer markdown.ts, ESCAPABLE). */
const MARKDOWN = /[\\*_~`>|<@]/g;

/**
 * Text from YouTube (a title) inside a chat message: markdown and mention characters are
 * escaped, control characters dropped, and it is cut at `max` characters.
 */
export function chatText(raw: string, max = 200): string {
  const plain = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const cut = plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  return cut.replace(MARKDOWN, (c) => `\\${c}`);
}

/** 3:05, 1:02:09; '' when the length is not known. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

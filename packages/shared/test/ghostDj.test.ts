import { describe, expect, it } from 'vitest';
import {
  GHOST_DJ_COOKIES_MAX_BYTES,
  GHOST_DJ_EQ_BANDS,
  GHOST_DJ_EQ_PRESETS,
  ghostDjControlSchema,
  ghostDjCookiesProblem,
  ghostDjEqSchema,
  ghostDjStateSchemaClient,
  ghostDjVolumeSchema,
} from '../src/index.js';

/** A cookie line with obviously fake values (never a real-looking secret in the repository). */
const cookie = (domain: string, expiry = '1900000000') => [domain, 'TRUE', '/', 'TRUE', expiry, 'test_name', ['test', 'value'].join('-')].join('\t');

describe('Ghost DJ panel schemas', () => {
  it('the server takes a preset or five whole gains from -12 to 12, a volume 0-100 and four actions, nothing more', () => {
    expect(ghostDjEqSchema.parse({ preset: 'electronic' })).toEqual({ preset: 'electronic' });
    expect(ghostDjEqSchema.parse({ gains: [-12, 0, 3, 12, 1] })).toEqual({ gains: [-12, 0, 3, 12, 1] });
    for (const bad of [{ gains: [0, 0, 0, 0] }, { gains: [0, 0, 0, 0, 0.5] }, { gains: [0, 0, 0, 0, 13] }, { preset: 'custom' }, { preset: 'rock', gains: [0, 0, 0, 0, 0] }, {}]) {
      expect(ghostDjEqSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ghostDjVolumeSchema.safeParse({ volume: 101 }).success).toBe(false);
    expect(ghostDjControlSchema.safeParse({ action: 'loop' }).success).toBe(false);
    expect(Object.values(GHOST_DJ_EQ_PRESETS).every((g) => g.length === GHOST_DJ_EQ_BANDS.length)).toBe(true);
  });

  it('the app reads a state leniently: unknown keys dropped, odd values made safe', () => {
    const state = ghostDjStateSchemaClient.parse({
      channelId: 'c1',
      current: { title: 'Música', url: 'https://www.youtube.com/watch?v=x', durationSec: 200, requestedBy: 'u1', requesterName: 'Ana', extra: 1 },
      positionSec: -5,
      paused: false,
      volume: 70,
      loop: 'shuffle',
      next: [],
      queueLength: 0,
      eq: { preset: 'jazz', gains: [3, 40, 'x', -2] },
      future: true,
    });
    expect(state).toEqual({
      channelId: 'c1',
      current: { title: 'Música', url: 'https://www.youtube.com/watch?v=x', durationSec: 200, requestedBy: 'u1', requesterName: 'Ana' },
      positionSec: 0,
      paused: false,
      volume: 70,
      loop: 'off',
      next: [],
      queueLength: 0,
      eq: { preset: 'custom', gains: [3, 12, 0, -2, 0] },
    });
    // The cookies line is the owner's alone: absent for the others, odd values made safe.
    expect(ghostDjStateSchemaClient.parse({ ...state, cookies: { setAt: 5, content: 'x' } }).cookies).toEqual({ setAt: 5 });
    expect(ghostDjStateSchemaClient.parse({ ...state, cookies: null }).cookies).toBeNull();
    expect(ghostDjStateSchemaClient.parse({ ...state, cookies: 'yes' }).cookies).toBeUndefined();
  });

  it('takes a Netscape cookies file with a youtube.com cookie, at most 100 KB, as yt-dlp reads it', () => {
    const header = '# Netscape HTTP Cookie File';
    expect(ghostDjCookiesProblem([header, '', cookie('.youtube.com')].join('\n'))).toBeNull();
    // Windows line ends, a BOM, HttpOnly cookies, a subdomain and a session cookie (no expiry).
    expect(ghostDjCookiesProblem(`\uFEFF${header}\r\n#HttpOnly_${cookie('www.youtube.com', '')}\r\n`)).toBeNull();
    expect(ghostDjCookiesProblem([header, cookie('.google.com'), cookie('youtube.com')].join('\n'))).toBeNull();

    expect(ghostDjCookiesProblem([header, cookie('.google.com')].join('\n'))).toBe('no_youtube');
    expect(ghostDjCookiesProblem([header, cookie('.notyoutube.com')].join('\n'))).toBe('no_youtube');
    expect(ghostDjCookiesProblem('')).toBe('no_youtube');
    for (const bad of ['[{"domain": ".youtube.com"}]', cookie('.youtube.com').replace(/\t/g, ' '), cookie('.youtube.com', 'soon'), `${cookie('.youtube.com')}\textra`]) {
      expect(ghostDjCookiesProblem([header, bad].join('\n')), bad).toBe('format');
    }
    const big = [header, cookie('.youtube.com'), `# ${'x'.repeat(GHOST_DJ_COOKIES_MAX_BYTES)}`].join('\n');
    expect(ghostDjCookiesProblem(big)).toBe('too_large');
  });
});

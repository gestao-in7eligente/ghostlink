import { LIMITS, formatInviteLink, formatPasteCode, formatWebLink, parseJoinInput, toBase64Url, utf8 } from '@ghostlink/shared';
import type { InvitePayload } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';
import { OPEN_APP_TIMEOUT_MS, canTryAppLinkOnLoad, inviteFromFragment } from '../../docs-site/.vitepress/theme/lib/invite.js';

// The /j/ invite page (spec §3.5): the browser reads the #GL1-… fragment, which never reaches a
// server, and turns it into the ghostlink:// link to open plus the GL1- code to paste later.
const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => (i * 11) & 0xff));
const SITE = 'https://gestao-in7eligente.github.io/ghostlink';
const payload: InvitePayload = {
  addresses: ['203.0.113.7:7700', '[2001:db8::1]:7700', 'ghost.example.org'],
  serverKeyId: KEY_ID,
  inviteCode: 'ABCDEFGHJK',
  name: 'Sala dos Fantasmas',
};
const pasteCode = formatPasteCode(payload);
const fragmentOf = (webLink: string) => webLink.slice(webLink.indexOf('#'));
const glOf = (json: unknown) => `GL1-${toBase64Url(utf8(JSON.stringify(json)))}`;

describe('inviteFromFragment', () => {
  it('reads the fragment of a web link the server built', () => {
    const invite = inviteFromFragment(fragmentOf(formatWebLink(payload, SITE)));
    expect(invite).toEqual({
      deepLink: formatInviteLink(payload),
      pasteCode,
      name: 'Sala dos Fantasmas',
      addresses: ['203.0.113.7:7700', '[2001:db8::1]:7700', 'ghost.example.org:7700'],
    });
    // The app parses what the page hands it back to the same invite.
    expect(parseJoinInput(invite!.deepLink)).toEqual(parseJoinInput(pasteCode));
    expect(parseJoinInput(invite!.pasteCode)).toEqual(parseJoinInput(pasteCode));
  });

  it('accepts the fragment with or without "#", surrounding spaces and percent-encoding', () => {
    expect(inviteFromFragment(pasteCode)?.pasteCode).toBe(pasteCode);
    expect(inviteFromFragment(`#${pasteCode}`)?.pasteCode).toBe(pasteCode);
    expect(inviteFromFragment(`#%20${pasteCode}%20`)?.pasteCode).toBe(pasteCode);
    expect(inviteFromFragment(`#${encodeURIComponent(pasteCode)}`)?.pasteCode).toBe(pasteCode);
  });

  it('works for an invite without a code or a name (open or password servers)', () => {
    const invite = inviteFromFragment(`#${formatPasteCode({ addresses: ['10.0.0.2'], serverKeyId: KEY_ID })}`);
    expect(invite).toMatchObject({ name: null, addresses: ['10.0.0.2:7700'] });
    expect(invite!.deepLink).toBe(`ghostlink://join?h=10.0.0.2%3A7700&k=${KEY_ID}`);
  });

  it('finds nothing in an empty or unrelated fragment', () => {
    for (const hash of ['', '#', '#   ', '#top', '#gl1-abc', '#GL1-', '#%E0%A4%A', `#${'GL1-'.repeat(2)}`]) {
      expect(inviteFromFragment(hash), hash).toBeNull();
    }
  });

  it('only takes GL1- codes: a ghostlink:// link, a web link or an address in the fragment is refused', () => {
    expect(inviteFromFragment(`#${formatInviteLink(payload)}`)).toBeNull();
    expect(inviteFromFragment(`#${formatWebLink(payload, SITE)}`)).toBeNull();
    expect(inviteFromFragment('#203.0.113.7:7700')).toBeNull();
    expect(inviteFromFragment('#javascript:alert(1)')).toBeNull();
  });

  it('refuses a truncated or malformed code', () => {
    for (const code of [
      pasteCode.slice(0, -6), // cut by a chat app: the JSON no longer closes
      `${pasteCode}=`,
      `${pasteCode}.`,
      pasteCode.replace(/-/g, '+'),
      glOf({ h: ['203.0.113.7:7700'] }), // no server key
      glOf({ h: [], k: KEY_ID }),
      glOf({ h: ['203.0.113.7:7700'], k: 'short' }),
      glOf({ h: ['203.0.113.7:99999'], k: KEY_ID }),
      glOf({ h: ['203.0.113.7:7700'], k: KEY_ID, i: 'lowercase!' }),
      glOf({ h: Array.from({ length: LIMITS.inviteMaxAddresses + 1 }, (_, i) => `10.0.0.${i + 1}`), k: KEY_ID }),
      glOf(['not', 'an', 'object']),
      'GL1-not base64',
    ]) {
      expect(inviteFromFragment(`#${code}`), code).toBeNull();
    }
  });

  it('refuses an oversized fragment without parsing it', () => {
    expect(inviteFromFragment(`#GL1-${'A'.repeat(LIMITS.inviteMaxLength)}`)).toBeNull();
    expect(inviteFromFragment(`#${'%41'.repeat(100_000)}`)).toBeNull();
  });

  it('rebuilds the deep link from the parsed invite: nothing from the fragment is passed through raw', () => {
    const hostile = glOf({
      h: ['203.0.113.7:7700'],
      k: KEY_ID,
      n: 'Evil‮<img src=x onerror=alert(1)>&x=1#\n\u0000',
    });
    const invite = inviteFromFragment(`#${hostile}`);
    expect(invite).not.toBeNull();
    expect(invite!.deepLink.startsWith('ghostlink://join?')).toBe(true);
    const url = new URL(invite!.deepLink);
    expect([...url.searchParams.keys()]).toEqual(['h', 'k', 'n']);
    expect(url.hash).toBe('');
    expect(invite!.name).not.toMatch(/[\p{Cc}\p{Cf}]/u); // controls and bidi overrides are gone
    const parsed = parseJoinInput(hostile);
    if (parsed.kind !== 'invite') throw new Error('expected an invite');
    expect(invite!.pasteCode).toBe(formatPasteCode(parsed.invite)); // canonical re-encoding
  });

  it('gives the app 1.5 s to open before showing the download (spec §3.5)', () => {
    expect(OPEN_APP_TIMEOUT_MS).toBe(1500);
  });
});

describe('canTryAppLinkOnLoad', () => {
  it('tries ghostlink:// by itself in Chromium browsers, which ignore an unknown scheme', () => {
    expect(canTryAppLinkOnLoad('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe(true);
    expect(canTryAppLinkOnLoad('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe(true);
  });

  it('waits for a click in Firefox, which replaces the page with an error when the app is missing', () => {
    expect(canTryAppLinkOnLoad('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0')).toBe(false);
  });
});

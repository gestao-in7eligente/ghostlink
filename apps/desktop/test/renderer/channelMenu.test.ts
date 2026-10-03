import { describe, expect, it } from 'vitest';
import { formatInviteLink, formatPasteCode, formatWebLink, parseJoinInput, toBase64Url, type Channel, type InviteLinks } from '@ghostlink/shared';
import { formatChannelLink, parseChannelLink } from '../../src/shared/channelLink.js';
import type { SavedServer } from '../../src/shared/ipcTypes.js';
import { channelChip } from '../../src/renderer/features/channelMenu/channelChip.js';
import { channelMenuEntries, duplicateName, inviteLinksWithChannel, muteEnd, type ChannelMenuFacts } from '../../src/renderer/features/channelMenu/channelMenuModel.js';
import { effectiveNotifyMode, isChannelMuted, nextMuteEnd, pinnedFirst } from '../../src/renderer/features/channelMenu/channelPrefs.js';
import { cancelChannelRequest, channelLinkPlan, requestChannel, takeChannelRequest } from '../../src/renderer/features/channelMenu/channelRequest.js';

const KEY = toBase64Url(new Uint8Array(32).fill(3));
const C1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const C2 = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
const C3 = 'CCCCCCCCCCCCCCCCCCCCCCCCCC';

/** A member without rights, a read channel, nothing pinned or muted. */
const base: ChannelMenuFacts = { unread: false, canInvite: false, canManageChannels: false, pinned: false, muted: false };

function saved(extra: Partial<SavedServer> = {}): SavedServer {
  return { id: 's1', name: 'A', addresses: ['10.0.0.1:7700'], serverKeyId: KEY, nickname: 'Ana', addedAt: 1, ...extra };
}

describe("a text channel's menu: which items show (spec 2026-10-02-menu-do-canal §2)", () => {
  it('a site’s channel, for whoever manages sites: edit and remove the site before the channel items', () => {
    expect(channelMenuEntries({ ...base, canManageChannels: true, manageSite: true }).entries).toEqual([
      'markRead',
      'separator', 'pin', 'copyLink',
      'separator', 'mute', 'notify',
      'separator', 'editSite', 'removeSite',
      'separator', 'edit', 'duplicate', 'createText', 'delete',
      'separator', 'copyId',
    ]);
  });

  it('a member without rights: mark read (greyed with nothing new), pin, link, mute, notifications and the id', () => {
    const menu = channelMenuEntries(base);
    expect(menu.entries).toEqual(['markRead', 'separator', 'pin', 'copyLink', 'separator', 'mute', 'notify', 'separator', 'copyId']);
    expect(menu.disabled.has('markRead')).toBe(true);
    expect(channelMenuEntries({ ...base, unread: true }).disabled.size).toBe(0);
  });

  it('the invite needs CREATE_INVITES; the managers get edit, duplicate, create and delete', () => {
    expect(channelMenuEntries({ ...base, canInvite: true, canManageChannels: true }).entries).toEqual([
      'markRead',
      'separator', 'invite', 'pin', 'copyLink',
      'separator', 'mute', 'notify',
      'separator', 'edit', 'duplicate', 'createText', 'delete',
      'separator', 'copyId',
    ]);
  });

  it('a pinned channel offers to unpin it, a muted one to unmute it', () => {
    const entries = channelMenuEntries({ ...base, pinned: true, muted: true }).entries;
    expect(entries).toContain('unpin');
    expect(entries).toContain('unmute');
    expect(entries).not.toContain('pin');
    expect(entries).not.toContain('mute');
  });
});

describe('the effective notification mode: muted > the channel > the server', () => {
  it("follows the server's mode, then the channel's own", () => {
    expect(effectiveNotifyMode(null, C1, 0)).toBe('mentions');
    expect(effectiveNotifyMode(saved({ notify: 'all' }), C1, 0)).toBe('all');
    expect(effectiveNotifyMode(saved({ notify: 'all', channels: { [C1]: { notify: 'none' } } }), C1, 0)).toBe('none');
    expect(effectiveNotifyMode(saved({ notify: 'none', channels: { [C1]: { notify: 'all' } } }), C1, 0)).toBe('all');
    expect(effectiveNotifyMode(saved({ notify: 'none', channels: { [C1]: { notify: 'all' } } }), C2, 0)).toBe('none');
  });

  it('a muted channel raises nothing; a timed mute ends by itself', () => {
    const entry = saved({ channels: { [C1]: { notify: 'all', mutedUntil: 5_000 }, [C2]: { mutedUntil: null } } });
    expect(effectiveNotifyMode(entry, C1, 4_999)).toBe('none');
    expect(effectiveNotifyMode(entry, C1, 5_000)).toBe('all');
    expect(effectiveNotifyMode(entry, C2, Number.MAX_SAFE_INTEGER)).toBe('none');
    expect(isChannelMuted({}, 0)).toBe(false);
    expect(nextMuteEnd(entry, 1_000)).toBe(5_000);
    expect(nextMuteEnd(entry, 5_000)).toBeNull();
  });

  it('a mute chosen now ends 15 minutes to 24 hours later, or never', () => {
    expect(muteEnd(15, 1_000)).toBe(1_000 + 15 * 60_000);
    expect(muteEnd(1440, 0)).toBe(24 * 3_600_000);
    expect(muteEnd(null, 1_000)).toBeNull();
  });
});

describe('pinned channels', () => {
  const channels = [{ id: C1 }, { id: C2 }, { id: C3 }];

  it('come first, in the order they were pinned; the others keep the sidebar order', () => {
    expect(pinnedFirst(channels, [C3, C1]).map((c) => c.id)).toEqual([C3, C1, C2]);
    expect(pinnedFirst(channels, undefined).map((c) => c.id)).toEqual([C1, C2, C3]);
  });

  it('ignore a pin of a channel that is gone or I no longer see, and a repeated one', () => {
    expect(pinnedFirst(channels, ['ZZZZZZZZZZZZZZZZZZZZZZZZZZ', C2, C2]).map((c) => c.id)).toEqual([C2, C1, C3]);
  });
});

describe('"Duplicar canal" names the copy', () => {
  it('adds the suffix, cutting the name to fit the limit without splitting a character', () => {
    expect(duplicateName('geral', '-copia')).toBe('geral-copia');
    expect(duplicateName('x'.repeat(100), '-copia')).toBe(`${'x'.repeat(94)}-copia`);
    expect(duplicateName('ab😀', '-c', 5)).toBe('ab-c');
  });
});

describe('the channel link ghostlink://channel/<serverKeyId>/<channelId>', () => {
  it('round-trips and refuses anything else', () => {
    const link = formatChannelLink(KEY, C1);
    expect(link).toBe(`ghostlink://channel/${KEY}/${C1}`);
    expect(parseChannelLink(link)).toEqual({ kind: 'channel', serverKeyId: KEY, channelId: C1 });
    expect(parseChannelLink(`ghostlink://join?h=1.2.3.4&k=${KEY}`)).toBeNull();
    expect(parseChannelLink(42)).toBeNull();
    expect(() => formatChannelLink('short', C1)).toThrow();
  });

  it('opens the saved server with that key: selects the channel when it is on screen, says when it is not mine', () => {
    const list = [saved(), saved({ id: 's2', serverKeyId: toBase64Url(new Uint8Array(32).fill(5)) })];
    const link = { kind: 'channel', serverKeyId: KEY, channelId: C1 } as const;
    expect(channelLinkPlan(link, list, 's1')).toEqual({ kind: 'select' });
    expect(channelLinkPlan(link, list, 's2')).toEqual({ kind: 'open', server: list[0] });
    expect(channelLinkPlan(link, list, null)).toEqual({ kind: 'open', server: list[0] });
    expect(channelLinkPlan({ ...link, serverKeyId: toBase64Url(new Uint8Array(32).fill(6)) }, list, 's1')).toEqual({ kind: 'unknown' });
  });

  it("waits for that server's welcome, once, and not for another server's", () => {
    requestChannel(KEY, C1, 1_000);
    expect(takeChannelRequest('other', 1_000)).toBeNull();
    expect(takeChannelRequest(KEY, 2_000)).toBe(C1);
    expect(takeChannelRequest(KEY, 2_000)).toBeNull();
    requestChannel(KEY, C2, 1_000);
    expect(takeChannelRequest(KEY, 1_000 + 3 * 60_000)).toBeNull(); // too old
    requestChannel(KEY, C2, 1_000);
    cancelChannelRequest();
    expect(takeChannelRequest(KEY, 1_000)).toBeNull();
  });
});

describe('a channel link in a message', () => {
  const geral = { id: C1, name: 'geral', type: 'text' } as Channel;
  const voz = { id: C2, name: 'voz', type: 'voice' } as Channel;
  const onScreen = { serverKeyId: KEY, channels: { [C1]: geral, [C2]: voz } };
  const other = saved({ id: 's2', name: 'Outro', serverKeyId: toBase64Url(new Uint8Array(32).fill(5)) });

  it('names a channel of the server on screen that I see; one I cannot see (or a voice one) is unknown', () => {
    expect(channelChip(KEY, C1, { onScreen, saved: [saved()] })).toEqual({ kind: 'here', name: 'geral' });
    expect(channelChip(KEY, C2, { onScreen, saved: [saved()] })).toEqual({ kind: 'unknown' });
    expect(channelChip(KEY, C3, { onScreen, saved: [saved()] })).toEqual({ kind: 'unknown' });
  });

  it('names another server of my list by its name; a server not in it is unknown', () => {
    expect(channelChip(other.serverKeyId, C1, { onScreen, saved: [saved(), other] })).toEqual({ kind: 'elsewhere', server: 'Outro' });
    expect(channelChip(KEY, C1, { onScreen: null, saved: [saved()] })).toEqual({ kind: 'elsewhere', server: 'A' });
    expect(channelChip(other.serverKeyId, C1, { onScreen, saved: [saved()] })).toEqual({ kind: 'unknown' });
  });
});

describe('"Convite para o canal" adds the channel to the server\'s invite', () => {
  const SITE = 'https://example.github.io/ghostlink';
  const payload = { addresses: ['203.0.113.7:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa' };
  const links: InviteLinks = { code: 'ABCDEFGH23', link: formatInviteLink(payload), pasteCode: formatPasteCode(payload), webLink: formatWebLink(payload, SITE) };

  it('in all three forms, which the join reads back', () => {
    const withChannel = inviteLinksWithChannel(links, C1);
    expect(withChannel.code).toBe('ABCDEFGH23');
    expect(withChannel.webLink.startsWith(`${SITE}/j/#GL1-`)).toBe(true);
    for (const text of [withChannel.link, withChannel.pasteCode, withChannel.webLink]) {
      expect(parseJoinInput(text)).toEqual({ kind: 'invite', invite: { ...payload, channelId: C1 } });
    }
  });

  it('keeps the plain invite when the links cannot be read', () => {
    const odd = { ...links, pasteCode: 'nope' };
    expect(inviteLinksWithChannel(odd, C1)).toBe(odd);
  });
});

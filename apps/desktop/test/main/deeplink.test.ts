import { describe, expect, it, vi } from 'vitest';
import { formatInviteLink, formatPasteCode, toBase64Url } from '@ghostlink/shared';
import { DeepLinks, extractDeepLink, parseDeepLink, registerProtocolClient } from '../../src/main/deeplink.js';

const KEY = toBase64Url(new Uint8Array(32).fill(7));
const LINK = formatInviteLink({ addresses: ['203.0.113.7:7700', '192.168.0.10:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa do Zé' });

describe('extractDeepLink (spec §12: argv on first launch and in second-instance)', () => {
  it('finds the ghostlink:// item among the arguments Chromium adds', () => {
    expect(extractDeepLink(['C:\\GhostLink.exe', '--allow-file-access-from-files', LINK])).toBe(LINK);
    expect(extractDeepLink(['electron.exe', 'C:\\dev\\app', '--', LINK.replace('ghostlink://', 'GHOSTLINK://')])).toMatch(/^GHOSTLINK:\/\//);
  });

  it('ignores argv without a link, and oversized items', () => {
    expect(extractDeepLink(['C:\\GhostLink.exe'])).toBeNull();
    expect(extractDeepLink([`ghostlink://join?h=${'a'.repeat(3_000)}`])).toBeNull();
    expect(extractDeepLink(['--x=ghostlink://join?h=1.2.3.4'])).toBeNull();
  });
});

describe('parseDeepLink (zod limits: 8 addresses, 2 KB, ports 1..65535)', () => {
  it('accepts an invite link and keeps the name only as a hint', () => {
    expect(parseDeepLink(LINK)).toEqual({
      kind: 'invite',
      invite: { addresses: ['203.0.113.7:7700', '192.168.0.10:7700'], serverKeyId: KEY, inviteCode: 'ABCDEFGH23', name: 'Casa do Zé' },
    });
  });

  it.each([
    ['a GL1- paste code (not a link)', formatPasteCode({ addresses: ['1.2.3.4:7700'], serverKeyId: KEY })],
    ['an https link', 'https://example.com/j/#GL1-abc'],
    ['nine addresses', `ghostlink://join?h=${Array.from({ length: 9 }, (_, i) => `10.0.0.${i + 1}:7700`).join(',')}&k=${KEY}`],
    ['port 0', `ghostlink://join?h=10.0.0.1:0&k=${KEY}`],
    ['port 65536', `ghostlink://join?h=10.0.0.1:65536&k=${KEY}`],
    ['a bad key', 'ghostlink://join?h=10.0.0.1:7700&k=short'],
    ['another action', `ghostlink://delete?h=10.0.0.1:7700&k=${KEY}`],
    ['more than 2 KB', `ghostlink://join?h=10.0.0.1:7700&k=${KEY}&n=${'x'.repeat(2_100)}`],
    ['a non-string', 42],
  ])('refuses %s', (_label, value) => {
    expect(parseDeepLink(value)).toBeNull();
  });
});

describe('DeepLinks (delivery to the renderer)', () => {
  it('keeps the latest link until the renderer takes it, then sends new ones as events', () => {
    const sent: unknown[] = [];
    const links = new DeepLinks({ send: (p) => sent.push(p), log: () => {} });
    links.handle(LINK);
    expect(sent).toEqual([]); // the page is not listening yet
    expect(links.take()).toMatchObject({ kind: 'invite' });
    expect(links.take()).toBeNull();
    links.handle(LINK);
    expect(sent).toEqual([expect.objectContaining({ kind: 'invite' })]);
  });

  it('drops invalid links (and logs without the link itself)', () => {
    const log = vi.fn();
    const sent: unknown[] = [];
    const links = new DeepLinks({ send: (p) => sent.push(p), log });
    links.take();
    links.handle('ghostlink://join?h=nope');
    links.handle(null);
    expect(sent).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain('nope');
  });
});

describe('registerProtocolClient (spec §12)', () => {
  function fakeApp(isPackaged: boolean) {
    return { isPackaged, setAsDefaultProtocolClient: vi.fn(() => true) };
  }

  it('registers the packaged app for ghostlink://', () => {
    const app = fakeApp(true);
    expect(registerProtocolClient(app, { argv: ['C:\\GhostLink.exe'], execPath: 'C:\\GhostLink.exe', env: {} })).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('ghostlink', 'C:\\GhostLink.exe', []);
  });

  it('in development only with GHOSTLINK_REGISTER_PROTOCOL=1, passing the app path', () => {
    const app = fakeApp(false);
    expect(registerProtocolClient(app, { argv: ['electron.exe', 'out/main/index.js'], execPath: 'electron.exe', env: {} })).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    registerProtocolClient(app, { argv: ['electron.exe', 'out/main/index.js'], execPath: 'electron.exe', env: { GHOSTLINK_REGISTER_PROTOCOL: '1' } });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('ghostlink', 'electron.exe', [expect.stringMatching(/out[\\/]main[\\/]index\.js$/)]);
  });
});

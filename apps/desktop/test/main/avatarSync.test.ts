import { describe, expect, it } from 'vitest';
import { FEATURE_AVATARS, ProtocolError, type WelcomePayload } from '@ghostlink/shared';
import type { ActiveSession } from '../../src/main/controller.js';
import { AvatarSync, myServerAvatar } from '../../src/main/avatars/avatarSync.js';
import type { MyAvatar } from '../../src/main/avatars/avatarStore.js';
import { gif, sha256Hex, webp } from './avatarFixtures.js';

const ME = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function mine(bytes: Uint8Array): MyAvatar {
  return { info: { hash: sha256Hex(bytes), mime: 'image/webp' }, bytes };
}

function session(o: { avatar?: string | null; features?: string[]; members?: unknown } = {}): ActiveSession {
  const welcome = {
    self: { userId: ME, nickname: 'Ana', isOwner: false },
    sessionId: 'sid',
    serverTime: 0,
    server: { name: 'Casa', version: '0.2.2', joinMode: 'open', serverKeyId: 'k'.repeat(43) },
    features: o.features ?? [FEATURE_AVATARS],
    fileToken: 'token',
    protocol: { min: 1, max: 1 },
    members: o.members ?? [
      { userId: OTHER, nickname: 'Bia', avatar: sha256Hex(gif()) },
      { userId: ME, nickname: 'Ana', avatar: o.avatar ?? null },
    ],
  } as WelcomePayload;
  return { serverId: 's1', address: '127.0.0.1:7700', serverKeyId: 'k'.repeat(43), welcome, clockOffsetMs: 0, request: () => Promise.reject(new Error('unused')) };
}

function harness(initial: MyAvatar | null) {
  let current = initial;
  const calls: Array<{ op: 'upload' | 'clear'; session: ActiveSession; hash?: string }> = [];
  const warnings: string[] = [];
  let fail: Error | null = null;
  let gate: Promise<void> | null = null;
  const sync = new AvatarSync({
    store: { current: () => current },
    upload: async (s, bytes) => {
      calls.push({ op: 'upload', session: s, hash: sha256Hex(bytes) });
      if (gate) await gate;
      if (fail) throw fail;
      return sha256Hex(bytes);
    },
    clear: async (s) => {
      calls.push({ op: 'clear', session: s });
      if (gate) await gate;
      if (fail) throw fail;
    },
    warn: (message) => warnings.push(message),
  });
  return {
    sync,
    calls,
    warnings,
    set: (a: MyAvatar | null) => {
      current = a;
    },
    failWith: (e: Error | null) => {
      fail = e;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

describe('myServerAvatar', () => {
  it('reads my member’s photo from the welcome', () => {
    const hash = sha256Hex(webp());
    expect(myServerAvatar(session({ avatar: hash }).welcome)).toBe(hash);
    expect(myServerAvatar(session().welcome)).toBeNull();
  });

  it('treats a missing or odd members list as no photo', () => {
    expect(myServerAvatar(session({ members: undefined as never }).welcome)).toBeNull();
    for (const members of ['x', [{ userId: ME, avatar: 'NOT-A-HASH' }], [null], {}]) expect(myServerAvatar(session({ members }).welcome)).toBeNull();
  });
});

describe('AvatarSync (spec 2026-10-01 §4: after every welcome and every change)', () => {
  it('does nothing when the server already has my photo', async () => {
    const photo = mine(webp());
    const h = harness(photo);
    h.sync.onSession(session({ avatar: photo.info.hash }));
    await h.sync.idle();
    expect(h.calls).toEqual([]);
  });

  it('uploads my photo when the server has another one or none', async () => {
    const photo = mine(webp());
    for (const avatar of [null, sha256Hex(gif())]) {
      const h = harness(photo);
      const s = session({ avatar });
      h.sync.onSession(s);
      await h.sync.idle();
      expect(h.calls).toEqual([{ op: 'upload', session: s, hash: photo.info.hash }]);
    }
  });

  it('clears the server’s photo when I have none', async () => {
    const h = harness(null);
    const s = session({ avatar: sha256Hex(webp()) });
    h.sync.onSession(s);
    await h.sync.idle();
    expect(h.calls).toEqual([{ op: 'clear', session: s }]);
  });

  it('does nothing on a server without the avatars feature', async () => {
    const h = harness(mine(webp()));
    h.sync.onSession(session({ features: ['voice'] }));
    await h.sync.idle();
    h.sync.changed();
    await h.sync.idle();
    expect(h.calls).toEqual([]);
  });

  it('does nothing without a session', async () => {
    const h = harness(mine(webp()));
    h.sync.changed();
    h.sync.onSession(null);
    await h.sync.idle();
    expect(h.calls).toEqual([]);
  });

  it('sends a change made while connected, and remembers what the server now holds', async () => {
    const h = harness(null);
    h.sync.onSession(session());
    await h.sync.idle();
    expect(h.calls).toEqual([]);
    const photo = mine(webp());
    h.set(photo);
    h.sync.changed();
    await h.sync.idle();
    h.sync.changed(); // nothing new
    await h.sync.idle();
    expect(h.calls.map((c) => c.op)).toEqual(['upload']);
    h.set(null);
    h.sync.changed();
    await h.sync.idle();
    expect(h.calls.map((c) => c.op)).toEqual(['upload', 'clear']);
  });

  it('logs a failure without details that could leak, and retries at the next welcome', async () => {
    const photo = mine(webp());
    const h = harness(photo);
    h.failWith(new ProtocolError('RATE_LIMITED', `token ${photo.info.hash}`));
    h.sync.onSession(session());
    await h.sync.idle();
    expect(h.warnings).toEqual(['[avatars] upload failed: RATE_LIMITED']);
    h.failWith(null);
    h.sync.onSession(session()); // the next welcome (a reconnect)
    await h.sync.idle();
    expect(h.calls.map((c) => c.op)).toEqual(['upload', 'upload']);
  });

  it('a failure does not count as sent: the next change tries again', async () => {
    const h = harness(mine(webp()));
    h.failWith(new Error('ECONNRESET'));
    h.sync.onSession(session());
    await h.sync.idle();
    h.failWith(null);
    h.sync.changed();
    await h.sync.idle();
    expect(h.calls.map((c) => c.op)).toEqual(['upload', 'upload']);
    expect(h.warnings).toEqual(['[avatars] upload failed: INTERNAL']);
  });

  it('runs one transfer at a time and sends only the latest photo after a burst of changes', async () => {
    const h = harness(mine(webp(256, 256, { fill: 1 })));
    const release = h.hold();
    h.sync.onSession(session());
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
    h.set(mine(webp(256, 256, { fill: 2 })));
    h.sync.changed();
    const latest = mine(webp(256, 256, { fill: 3 }));
    h.set(latest);
    h.sync.changed();
    expect(h.calls).toHaveLength(1); // still the first one
    release();
    await h.sync.idle();
    expect(h.calls.map((c) => c.hash)).toEqual([sha256Hex(webp(256, 256, { fill: 1 })), latest.info.hash]);
  });

  it('a transfer that ends after the session changed does not decide for the new session', async () => {
    const photo = mine(webp());
    const h = harness(photo);
    const release = h.hold();
    const first = session();
    h.sync.onSession(first);
    await Promise.resolve();
    const second = session(); // a reconnect: the server still has no photo for me
    h.sync.onSession(second);
    release();
    await h.sync.idle();
    expect(h.calls.map((c) => c.session)).toEqual([first, second]);
  });

  it('stops after a disconnect', async () => {
    const h = harness(mine(webp()));
    const release = h.hold();
    h.sync.onSession(session());
    await Promise.resolve();
    h.sync.onSession(null);
    h.sync.changed();
    release();
    await h.sync.idle();
    expect(h.calls).toHaveLength(1);
  });
});

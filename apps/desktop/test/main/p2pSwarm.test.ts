import { createHash } from 'node:crypto';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { friendKeyFromSeed } from '../../src/main/p2p/friendKey.js';
import { FriendSwarm, type FriendLink } from '../../src/main/p2p/swarm.js';

const seed = (label: string) => createHash('sha256').update(label).digest();
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const text = (data: Uint8Array) => Buffer.from(data).toString();

// A real DHT on a slow CI runner (Windows) can need well over 10 s to reconnect after a restart.
vi.setConfig({ testTimeout: 120_000 });

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('FriendSwarm (spec §3.2) over a loopback DHT', () => {
  let testnet: Testnet;
  const nodes: FriendSwarm[] = [];
  const start = async (label: string, allow: (key: Uint8Array) => boolean) => {
    const node = await FriendSwarm.start({ seed: seed(label), allow, bootstrap: testnet.bootstrap, bindHost: '127.0.0.1' });
    nodes.push(node);
    return node;
  };

  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    await testnet.destroy();
  });

  it('derives the same public key from the same seed', async () => {
    const a = await start('same-seed', () => false);
    const b = await start('same-seed', () => false);
    expect(same(a.publicKey, b.publicKey)).toBe(true);
    expect(a.publicKey).toHaveLength(32);
  });

  it('links two friends and carries messages both ways', async () => {
    const keys: Record<'ana' | 'bia', Uint8Array> = { ana: new Uint8Array(), bia: new Uint8Array() };
    const ana = await start('ana', (key) => same(key, keys.bia));
    const bia = await start('bia', (key) => same(key, keys.ana));
    keys.ana = ana.publicKey;
    keys.bia = bia.publicKey;

    const anaGot: string[] = [];
    const biaGot: string[] = [];
    let anaLink: FriendLink | null = null;
    ana.onLink((link) => {
      anaLink = link;
      link.onData((d) => anaGot.push(text(d)));
    });
    bia.onLink((link) => {
      link.onData((d) => biaGot.push(text(d)));
      link.send(Buffer.from('oi ana'));
    });
    bia.connectTo(ana.publicKey);

    await until(() => anaGot.length === 1);
    expect(anaGot).toEqual(['oi ana']);
    expect(same(anaLink!.remoteKey, bia.publicKey)).toBe(true);
    anaLink!.send(Buffer.from('oi bia'));
    await until(() => biaGot.length === 1);
    expect(biaGot).toEqual(['oi bia']);
  });

  it('refuses a key the firewall does not allow, without opening a link on either side', async () => {
    const owner = await start('owner', () => false);
    const stranger = await start('stranger', () => true);
    let ownerLinks = 0;
    let strangerLinks = 0;
    owner.onLink(() => ownerLinks++);
    stranger.onLink(() => strangerLinks++);
    stranger.connectTo(owner.publicKey);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(ownerLinks).toBe(0);
    expect(strangerLinks).toBe(0);
  });

  it('tells when a link closes, and stop() ends the node', async () => {
    const keys: Record<'a' | 'b', Uint8Array> = { a: new Uint8Array(), b: new Uint8Array() };
    const a = await start('close-a', (key) => same(key, keys.b));
    const b = await start('close-b', (key) => same(key, keys.a));
    keys.a = a.publicKey;
    keys.b = b.publicKey;
    let closed = false;
    let linked = false;
    a.onLink((link) => {
      linked = true;
      link.onClose(() => {
        closed = true;
      });
    });
    b.connectTo(a.publicKey);
    await until(() => linked);
    await b.stop();
    await until(() => closed);
    expect(closed).toBe(true);
  });
});

describe('FriendSwarm: a refusal does not outlive the moment it was made', () => {
  let testnet: Testnet;
  const nodes: FriendSwarm[] = [];
  const start = async (label: string, allow: (key: Uint8Array) => boolean) => {
    const node = await FriendSwarm.start({ seed: seed(label), allow, bootstrap: testnet.bootstrap, bindHost: '127.0.0.1' });
    nodes.push(node);
    return node;
  };
  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    await testnet.destroy();
  });

  it('reaches a key that was refused before it was allowed (Hyperswarm\'s ban does not stick)', async () => {
    const allowed = new Set<string>();
    const hex = (key: Uint8Array) => Buffer.from(key).toString('hex');
    const ana = await start('ban-ana', (key) => allowed.has(hex(key)));
    const bia = await start('ban-bia', () => true);
    let links = 0;
    ana.onLink(() => links++);

    // Refused while going out: nothing may open.
    ana.connectTo(bia.publicKey);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(links).toBe(0);

    allowed.add(hex(bia.publicKey));
    ana.connectTo(bia.publicKey);
    await until(() => links > 0);
  });

  it('stops reaching for a peer after disconnectFrom', async () => {
    const a = await start('leave-a', () => true);
    const b = await start('leave-b', () => true);
    let opened = 0;
    let closed = 0;
    a.onLink((link) => {
      opened++;
      link.onClose(() => closed++);
      a.disconnectFrom(b.publicKey);
      link.close();
    });
    a.connectTo(b.publicKey);
    await until(() => closed === 1);
    // Hyperswarm retries an explicit peer about a second after it drops.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(opened).toBe(1);
  });
});

describe('FriendSwarm inbox (spec §3.2) over a loopback DHT', () => {
  let testnet: Testnet;
  const nodes: FriendSwarm[] = [];
  const start = async (label: string, allow: (key: Uint8Array) => boolean = () => false) => {
    const node = await FriendSwarm.start({ seed: seed(label), allow, bootstrap: testnet.bootstrap, bindHost: '127.0.0.1' });
    nodes.push(node);
    return node;
  };
  const inboxKey = (label: string) => friendKeyFromSeed(seed(label)).publicKey;

  beforeAll(async () => {
    testnet = await createTestnet(3);
  });
  afterAll(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    await testnet.destroy();
  });

  it('listens on a second key, names who knocked and shares one handshake hash with them', async () => {
    const owner = await start('inbox-owner');
    const asker = await start('inbox-asker');
    let ownerLink: FriendLink | null = null;
    let friendLinks = 0;
    owner.onLink(() => friendLinks++);
    asker.onLink(() => friendLinks++);
    const ownerGot: string[] = [];
    await owner.setInbox({
      seed: seed('inbox-1'),
      allow: () => true,
      onLink: (link) => {
        ownerLink = link;
        link.onData((d) => ownerGot.push(text(d)));
        link.send(Buffer.from('quem é?'));
      },
    });

    const link = await asker.requestVia(inboxKey('inbox-1'));
    const askerGot: string[] = [];
    link.onData((d) => askerGot.push(text(d)));
    await until(() => askerGot.length === 1);
    expect(askerGot).toEqual(['quem é?']);
    expect(same(link.remoteKey, inboxKey('inbox-1'))).toBe(true);
    expect(same(ownerLink!.remoteKey, asker.publicKey)).toBe(true);
    expect(link.handshakeHash).toHaveLength(64);
    expect(same(link.handshakeHash, ownerLink!.handshakeHash)).toBe(true);

    // The owner finishes cleanly: the asker sees the end, then the close.
    const seen: string[] = [];
    link.onEnd(() => {
      seen.push('end');
      link.end();
    });
    link.onClose(() => seen.push('close'));
    link.send(Buffer.from('sou a Ana'));
    await until(() => ownerGot.length === 1);
    ownerLink!.end();
    await until(() => seen.length === 2);
    expect(seen).toEqual(['end', 'close']);
    // An inbox connection is never a friend link.
    expect(friendLinks).toBe(0);

    // Every connection has its own handshake hash.
    const again = await asker.requestVia(inboxKey('inbox-1'));
    expect(same(again.handshakeHash, link.handshakeHash)).toBe(false);
    again.close();
  });

  it('a link that is dropped closes without an end', async () => {
    const owner = await start('drop-owner');
    const asker = await start('drop-asker');
    await owner.setInbox({ seed: seed('inbox-drop'), allow: () => true, onLink: (link) => link.onData(() => link.close()) });
    const link = await asker.requestVia(inboxKey('inbox-drop'));
    const seen: string[] = [];
    link.onEnd(() => seen.push('end'));
    link.onClose(() => seen.push('close'));
    link.onData(() => {});
    link.send(Buffer.from('x'));
    await until(() => seen.length > 0);
    expect(seen).toEqual(['close']);
  });

  it('refuses a key the inbox does not allow, before a link opens', async () => {
    const owner = await start('fw-owner');
    const asker = await start('fw-asker');
    const asked: Uint8Array[] = [];
    let links = 0;
    await owner.setInbox({
      seed: seed('inbox-fw'),
      allow: (key) => {
        asked.push(key);
        return false;
      },
      onLink: () => links++,
    });
    await expect(asker.requestVia(inboxKey('inbox-fw'), 8_000)).rejects.toThrow();
    expect(links).toBe(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(same(asked[0]!, asker.publicKey)).toBe(true);
  });

  it('gives up on an inbox that does not answer in time', async () => {
    const owner = await start('slow-owner');
    const asker = await start('slow-asker');
    await owner.setInbox({ seed: seed('inbox-slow'), allow: () => false, onLink: () => {} });
    const started = Date.now();
    await expect(asker.requestVia(inboxKey('inbox-slow'), 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('moves with the seed and goes away when turned off', async () => {
    const owner = await start('move-owner');
    const asker = await start('move-asker');
    const opts = (label: string) => ({ seed: seed(label), allow: () => true, onLink: (link: FriendLink) => link.onData(() => {}) });
    await owner.setInbox(opts('inbox-old'));
    (await asker.requestVia(inboxKey('inbox-old'))).close();

    await owner.setInbox(opts('inbox-new'));
    await expect(asker.requestVia(inboxKey('inbox-old'))).rejects.toThrow();
    (await asker.requestVia(inboxKey('inbox-new'))).close();

    await owner.setInbox(null);
    await expect(asker.requestVia(inboxKey('inbox-new'))).rejects.toThrow();
  });

  it('the inbox does not open the friend key: a stranger there is still refused', async () => {
    const owner = await start('two-owner');
    const stranger = await start('two-stranger', () => true);
    await owner.setInbox({ seed: seed('inbox-two'), allow: () => true, onLink: () => {} });
    let links = 0;
    owner.onLink(() => links++);
    stranger.onLink(() => links++);
    stranger.connectTo(owner.publicKey);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(links).toBe(0);
  });

  it('stop() closes the inbox, and nothing can be asked afterwards', async () => {
    const owner = await start('stop-owner');
    const asker = await start('stop-asker');
    await owner.setInbox({ seed: seed('inbox-stop'), allow: () => true, onLink: () => {} });
    await owner.stop();
    await expect(asker.requestVia(inboxKey('inbox-stop'))).rejects.toThrow();
    await expect(owner.requestVia(inboxKey('inbox-stop'))).rejects.toThrow();
    await expect(owner.setInbox({ seed: seed('inbox-stop'), allow: () => true, onLink: () => {} })).rejects.toThrow();
  });
});

describe('p2pSelfTest (the smoke run\'s P2P check)', () => {
  it('links two nodes over its own loopback DHT and cleans up', async () => {
    const { p2pSelfTest } = await import('../../src/main/p2p/selfTest.js');
    await expect(p2pSelfTest()).resolves.toBeUndefined();
  });
});

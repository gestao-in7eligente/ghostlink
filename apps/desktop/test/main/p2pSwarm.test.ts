import { createHash } from 'node:crypto';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FriendSwarm, type FriendLink } from '../../src/main/p2p/swarm.js';

const seed = (label: string) => createHash('sha256').update(label).digest();
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const text = (data: Uint8Array) => Buffer.from(data).toString();

async function until(check: () => boolean, ms = 10_000): Promise<void> {
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

describe('p2pSelfTest (the smoke run\'s P2P check)', () => {
  it('links two nodes over its own loopback DHT and cleans up', async () => {
    const { p2pSelfTest } = await import('../../src/main/p2p/selfTest.js');
    await expect(p2pSelfTest()).resolves.toBeUndefined();
  });
});

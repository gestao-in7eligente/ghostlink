import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import { FriendSwarm } from './swarm.js';

const GREETING = 'ghostlink-p2p';

/**
 * Proves the P2P stack works in this very process: the native modules load and two nodes
 * link over a private DHT on 127.0.0.1 (nothing leaves the machine, no firewall prompt).
 * Rejects with a short reason when anything fails.
 */
export async function p2pSelfTest(timeoutMs = 15_000): Promise<void> {
  const testnet = await createTestnet(3);
  const nodes: FriendSwarm[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const start = async () => {
      const node = await FriendSwarm.start({ seed: randomBytes(32), allow: () => true, bootstrap: testnet.bootstrap, bindHost: '127.0.0.1' });
      nodes.push(node);
      return node;
    };
    const receiver = await start();
    const sender = await start();
    const received = new Promise<string>((resolve) => {
      receiver.onLink((link) => link.onData((data) => resolve(Buffer.from(data).toString())));
    });
    sender.onLink((link) => link.send(Buffer.from(GREETING)));
    sender.connectTo(receiver.publicKey);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('P2P self-test timed out')), timeoutMs);
    });
    if ((await Promise.race([received, timeout])) !== GREETING) throw new Error('P2P self-test got a wrong message');
  } finally {
    clearTimeout(timer);
    await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
    await testnet.destroy().catch(() => undefined);
  }
}

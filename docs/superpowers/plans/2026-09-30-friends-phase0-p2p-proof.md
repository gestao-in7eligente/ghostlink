# Friends Phase 0 — P2P Technical Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that Hyperswarm runs inside the GhostLink desktop app (tests, development and the packaged Windows build with the current fuses), and land the first real building block of the P2P engine.

**Architecture:** A small `FriendSwarm` class in the main process wraps one Hyperswarm instance: it listens on a key derived from a seed, connects to explicit peers (`joinPeer`) and refuses every remote key the caller does not allow (the firewall of spec §3.2). The packaged-app smoke test gains a P2P self-test that runs two nodes over a loopback DHT inside the real Electron main process.

**Tech Stack:** `hyperswarm` 4.17.2 and `hyperdht` 6.34.0 (MIT; native prebuilds `udx-native`, `sodium-native`), Electron 44, vitest 5, TypeScript 6.

**Spec:** `docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md` (§3.1, §3.2, §12 phase 0, §13).

**What is already known (scratch probes, 2026-09-30, this Windows machine):**
- Under plain Node 24.14 and under Electron 44.4.5 with `ELECTRON_RUN_AS_NODE=1`, two Hyperswarm nodes connect over `hyperdht/testnet` and exchange a message; a third node whose key the firewall rejects never gets a connection.
- Over the public DHT, inside Electron's runtime: `listen()` took 4.4 s and the connection 2.3 s (both nodes on this machine, behind the same NAT).
- Not yet proven: the real main process (not run-as-node), the packaged app (asar, fuses), and a connection between two different networks (needs a second person; done with the owner once Phase 1 has a UI).

**Branch:** create `v0.3-friends` from `v0.2-railway` and work there. Do not push.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/package.json` | Adds `hyperswarm` and `hyperdht` as exact runtime dependencies. |
| `apps/desktop/src/main/p2p/hyperswarm.d.ts` | Minimal types for the two untyped packages (only what we call). |
| `apps/desktop/src/main/p2p/swarm.ts` | `FriendSwarm`: listen, connect to a peer, firewall, links. Later phases add the inbox here. |
| `apps/desktop/src/main/p2p/selfTest.ts` | `p2pSelfTest()`: two nodes over a loopback DHT in the current process. |
| `apps/desktop/src/main/smoke.ts` | The smoke run calls the optional P2P check. |
| `apps/desktop/src/main/index.ts` | Passes `p2pSelfTest` to the smoke run. |
| `apps/desktop/test/main/p2pSwarm.test.ts` | Integration test over `hyperdht/testnet`. |
| `apps/desktop/test/main/smoke.test.ts` | The P2P step of the smoke run. |
| `scripts/test/electronBuilderConfig.test.ts` | The pinned list of runtime dependencies. |
| `docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md` | Records the result of this phase. |

---

### Task 1: Branch and dependencies

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `scripts/test/electronBuilderConfig.test.ts:113`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b v0.3-friends
```

- [ ] **Step 2: Update the pinned dependency list first (failing test)**

In `scripts/test/electronBuilderConfig.test.ts`, replace the comment line above `RUNTIME_DEPENDENCIES` and the constant:

```ts
  // livekit-server-sdk: the hosted server's LiveKit client; uiohook-napi: native global push-to-talk hook;
  // hyperswarm + hyperdht: the P2P engine for friends and DMs (native prebuilds udx-native, sodium-native).
  const RUNTIME_DEPENDENCIES = ['@peculiar/x509', 'electron-updater', 'hyperdht', 'hyperswarm', 'livekit-server-sdk', 'reflect-metadata', 'uiohook-napi', 'ws', 'zod'];
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run scripts/test/electronBuilderConfig.test.ts`
Expected: FAIL in "ships only the packages the bundles load at run time" (the two names are missing from `dependencies`).

- [ ] **Step 4: Install the packages, exact versions**

```bash
npm install hyperswarm@4.17.2 hyperdht@6.34.0 -w @ghostlink/desktop --save-exact --fetch-retries=6 --no-audit --no-fund
```

Expected: `apps/desktop/package.json` gains `"hyperdht": "6.34.0"` and `"hyperswarm": "4.17.2"` under `dependencies` (no `^`).

- [ ] **Step 5: Run the test again**

Run: `npx vitest run scripts/test/electronBuilderConfig.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json package-lock.json scripts/test/electronBuilderConfig.test.ts
git commit -m "build(desktop): hyperswarm and hyperdht for the P2P engine"
```

---

### Task 2: `FriendSwarm` over a loopback DHT

**Files:**
- Create: `apps/desktop/src/main/p2p/hyperswarm.d.ts`
- Create: `apps/desktop/src/main/p2p/swarm.ts`
- Test: `apps/desktop/test/main/p2pSwarm.test.ts`

- [ ] **Step 1: Write the type declarations**

`apps/desktop/src/main/p2p/hyperswarm.d.ts`:

```ts
// Minimal types for the untyped Holepunch packages: only what the P2P engine calls.
declare module 'hyperdht' {
  export interface BootstrapNode {
    host: string;
    port: number;
  }
  export interface DhtOptions {
    bootstrap?: BootstrapNode[];
    /** The address the UDP sockets bind to (default: every interface). */
    host?: string;
  }
  export default class DHT {
    constructor(opts?: DhtOptions);
    destroy(): Promise<void>;
  }
}

declare module 'hyperdht/testnet.js' {
  import type { BootstrapNode } from 'hyperdht';
  export interface Testnet {
    bootstrap: BootstrapNode[];
    destroy(): Promise<void>;
  }
  /** A private DHT on 127.0.0.1 with `size` nodes, for tests and the self-test. */
  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  import type DHT from 'hyperdht';
  import type { BootstrapNode } from 'hyperdht';

  /** The encrypted stream between two peers (a streamx Duplex; each write arrives as one `data`). */
  export interface SwarmConnection extends EventEmitter {
    readonly remotePublicKey: Buffer;
    write(data: Uint8Array): boolean;
    destroy(error?: Error): void;
  }
  export interface HyperswarmOptions {
    /** 32 bytes; the node's Ed25519 key pair is derived from it. */
    seed?: Buffer;
    bootstrap?: BootstrapNode[];
    dht?: DHT;
    /** Return true to REJECT an incoming connection from that key. */
    firewall?: (remotePublicKey: Buffer) => boolean;
  }
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
    listen(): Promise<void>;
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    destroy(): Promise<void>;
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/desktop/test/main/p2pSwarm.test.ts`:

```ts
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
    const keys = { ana: new Uint8Array(), bia: new Uint8Array() };
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
    const keys = { a: new Uint8Array(), b: new Uint8Array() };
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run --project desktop apps/desktop/test/main/p2pSwarm.test.ts`
Expected: FAIL — cannot resolve `../../src/main/p2p/swarm.js`.

- [ ] **Step 4: Write the implementation**

`apps/desktop/src/main/p2p/swarm.ts`:

```ts
// The P2P node of the friends feature (spec 2026-09-30 §3.1, §3.2): one Hyperswarm instance
// whose key is the friend key. It listens on that key, connects to explicit peers and
// refuses every incoming key the caller does not allow, before a connection opens.
import DHT, { type BootstrapNode } from 'hyperdht';
import Hyperswarm, { type SwarmConnection } from 'hyperswarm';

/** An encrypted, authenticated connection to one peer; each send() arrives as one onData(). */
export interface FriendLink {
  readonly remoteKey: Uint8Array;
  send(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface FriendSwarmOptions {
  /** 32 bytes; the node's key pair comes from it (the friend seed, spec §2). */
  seed: Uint8Array;
  /** The firewall: true lets that remote key connect to us. */
  allow(remoteKey: Uint8Array): boolean;
  /** DHT bootstrap nodes; default: Hyperswarm's public ones. */
  bootstrap?: BootstrapNode[];
  /** Bind address of the UDP sockets; tests and the self-test use 127.0.0.1. */
  bindHost?: string;
}

export class FriendSwarm {
  readonly #swarm: Hyperswarm;
  readonly #listeners = new Set<(link: FriendLink) => void>();

  private constructor(swarm: Hyperswarm) {
    this.#swarm = swarm;
    swarm.on('connection', (conn: SwarmConnection) => this.#accept(conn));
  }

  /** Creates the node and starts listening on its key. */
  static async start(opts: FriendSwarmOptions): Promise<FriendSwarm> {
    const dht = new DHT({
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      ...(opts.bindHost ? { host: opts.bindHost } : {}),
    });
    const swarm = new Hyperswarm({ seed: Buffer.from(opts.seed), dht, firewall: (remoteKey) => !opts.allow(remoteKey) });
    const node = new FriendSwarm(swarm);
    await swarm.listen();
    return node;
  }

  get publicKey(): Uint8Array {
    return this.#swarm.keyPair.publicKey;
  }

  /** Keeps trying to reach that peer until stop(); a link shows up in onLink on both sides. */
  connectTo(remoteKey: Uint8Array): void {
    this.#swarm.joinPeer(Buffer.from(remoteKey));
  }

  /** Called for every link, whoever opened it. Returns the unsubscribe function. */
  onLink(listener: (link: FriendLink) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Closes every link and leaves the DHT. */
  async stop(): Promise<void> {
    await this.#swarm.destroy();
  }

  #accept(conn: SwarmConnection): void {
    // A dropped peer is normal (it shows as onClose), never an unhandled 'error'.
    conn.on('error', () => {});
    const link: FriendLink = {
      remoteKey: conn.remotePublicKey,
      send: (data) => void conn.write(data),
      onData: (listener) => void conn.on('data', listener),
      onClose: (listener) => void conn.on('close', listener),
      close: () => conn.destroy(),
    };
    for (const listener of this.#listeners) listener(link);
  }
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run --project desktop apps/desktop/test/main/p2pSwarm.test.ts`
Expected: PASS, 4 tests.

If `hyperdht`'s own constructor options differ from the declaration (for example the bind option is not `host`), read `node_modules/hyperdht/index.js` and `node_modules/dht-rpc/index.js`, fix the declaration and the call, and note it in Task 5's findings.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc -p apps/desktop/tsconfig.node.json --noEmit && npx eslint apps/desktop`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/p2p apps/desktop/test/main/p2pSwarm.test.ts
git commit -m "feat(desktop): FriendSwarm, the P2P node with a key firewall"
```

---

### Task 3: P2P self-test in the smoke run

**Files:**
- Create: `apps/desktop/src/main/p2p/selfTest.ts`
- Modify: `apps/desktop/src/main/smoke.ts`
- Modify: `apps/desktop/src/main/index.ts` (the `runSmoke({ … })` call in `startSmoke`)
- Test: `apps/desktop/test/main/smoke.test.ts`
- Test: `apps/desktop/test/main/p2pSwarm.test.ts`

- [ ] **Step 1: Write the failing tests for the smoke run**

Add to the `describe('runSmoke', …)` block of `apps/desktop/test/main/smoke.test.ts`:

```ts
  it('runs the P2P check after the hosted server stopped, and says so', async () => {
    const messages: string[] = [];
    const { d, calls, exits } = deps({ log: (m) => messages.push(m) });
    d.p2p = async () => {
      calls.push('p2p');
    };
    await runSmoke(d);
    expect(calls).toEqual(['load', 'ready?', 'ready?', 'ready?', 'fork', 'shutdown', 'p2p']);
    expect(exits).toEqual([0]);
    expect(messages[0]).toMatch(/^smoke: OK \(.*P2P link exchanged a message\)$/);
  });

  it('fails when the P2P check fails', async () => {
    const messages: string[] = [];
    const { d, exits } = deps({ log: (m) => messages.push(m) });
    d.p2p = async () => Promise.reject(new Error('P2P self-test timed out'));
    await runSmoke(d);
    expect(exits).toEqual([1]);
    expect(messages).toEqual(['smoke: FAILED (P2P self-test timed out)']);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project desktop apps/desktop/test/main/smoke.test.ts`
Expected: FAIL — `p2p` does not exist on `SmokeDeps`, and the OK message has no P2P text.

- [ ] **Step 3: Extend the smoke run**

In `apps/desktop/src/main/smoke.ts`, add to `SmokeDeps` after `forkServer`:

```ts
  /** The P2P engine's self-test (friends and DMs); omitted where it cannot run. */
  p2p?(): Promise<void>;
```

Replace the doc comment's middle sentence and the success path. The function body from `const server = await deps.forkServer();` to the `finish(0, …)` line becomes:

```ts
    const server = await deps.forkServer();
    try {
      await probeServerKeyId(`127.0.0.1:${server.port}`, { timeoutMs: 5_000 });
    } finally {
      await server.shutdown();
    }
    if (deps.p2p) await deps.p2p();
    finish(0, `smoke: OK (renderer ready, hosted server served TLS on port ${server.port} and stopped${deps.p2p ? ', P2P link exchanged a message' : ''})`);
```

And the doc comment of `runSmoke` becomes:

```ts
/**
 * GHOSTLINK_SMOKE=1 (contract §5, spec §14): proves the built app works end to end —
 * the renderer loaded through app://, the preload bridge and IPC answer, a hosted
 * server starts in a utility process, serves TLS and stops, and the P2P engine's
 * native modules load and link two nodes. Exits 0 on success and 1 on any failure
 * or after the timeout; exit() is called exactly once.
 */
```

- [ ] **Step 4: Run the smoke tests**

Run: `npx vitest run --project desktop apps/desktop/test/main/smoke.test.ts`
Expected: PASS (the earlier tests still pass: without `p2p` the message is unchanged).

- [ ] **Step 5: Write the failing test for the self-test**

Add at the end of `apps/desktop/test/main/p2pSwarm.test.ts`:

```ts
describe('p2pSelfTest (the smoke run\'s P2P check)', () => {
  it('links two nodes over its own loopback DHT and cleans up', async () => {
    const { p2pSelfTest } = await import('../../src/main/p2p/selfTest.js');
    await expect(p2pSelfTest()).resolves.toBeUndefined();
  });
});
```

Run: `npx vitest run --project desktop apps/desktop/test/main/p2pSwarm.test.ts`
Expected: FAIL — cannot resolve `selfTest.js`.

- [ ] **Step 6: Write the self-test**

`apps/desktop/src/main/p2p/selfTest.ts`:

```ts
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
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project desktop apps/desktop/test/main/p2pSwarm.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Wire it into the app's smoke mode**

In `apps/desktop/src/main/index.ts`, add the import next to the other `./` imports (alphabetical order is kept in that block):

```ts
import { p2pSelfTest } from './p2p/selfTest.js';
```

and in `startSmoke`, inside the object passed to `runSmoke`, add after the `forkServer` property:

```ts
    p2p: () => p2pSelfTest(),
```

- [ ] **Step 9: Typecheck, lint, and the development smoke**

Run: `npx tsc -p apps/desktop/tsconfig.node.json --noEmit && npx eslint apps/desktop`
Expected: no output.

Run: `npm run smoke:dev`
Expected: the last line is `smoke: OK`. In `apps/desktop`'s log output above it, the app's own line reads `smoke: OK (renderer ready, hosted server served TLS on port <n> and stopped, P2P link exchanged a message)`. This is the proof for the real (unpackaged) Electron main process.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/p2p/selfTest.ts apps/desktop/src/main/smoke.ts apps/desktop/src/main/index.ts apps/desktop/test/main/smoke.test.ts apps/desktop/test/main/p2pSwarm.test.ts
git commit -m "feat(desktop): the smoke run proves the P2P engine links two nodes"
```

---

### Task 4: The packaged app

**Files:** none changed unless packaging needs a fix (then `apps/desktop/electron-builder.yml`).

- [ ] **Step 1: Build the installer and run the packaged smoke**

```bash
npm run dist
npm run smoke
```

Expected: `npm run smoke` ends with a line starting with `smoke: OK (` that contains `P2P link exchanged a message`. This proves the native modules load from the packaged app (asar, the current fuses, `npmRebuild: false`).

- [ ] **Step 2: Check where the native files ended up**

```bash
find apps/desktop/dist/win-unpacked/resources -name "*.node" | grep -E "udx-native|sodium-native"
```

Expected: `udx-native.node` and `sodium-native.node` for `win32-x64` under `resources/app.asar.unpacked/node_modules/…/prebuilds/win32-x64/`.

- [ ] **Step 3: Only if Step 1 failed to load a native module**

Add to `apps/desktop/electron-builder.yml`, after the `asar: true` line:

```yaml
# The P2P engine's native prebuilds must be real files next to the archive (dlopen cannot read asar).
asarUnpack:
  - node_modules/udx-native/**
  - node_modules/sodium-native/**
```

Then repeat Step 1. `scripts/test/electronBuilderConfig.test.ts` validates the file against electron-builder's schema; run `npx vitest run scripts/test/electronBuilderConfig.test.ts` and commit:

```bash
git add apps/desktop/electron-builder.yml
git commit -m "build(desktop): unpack the P2P native prebuilds"
```

If it still fails, stop and report the exact error: the fallback of spec §3.1 (a `utilityProcess`) uses the same Electron runtime, so the decision goes back to the owner.

- [ ] **Step 4: Measure what the packages add**

```bash
du -sh apps/desktop/dist/win-unpacked/resources/app.asar.unpacked/node_modules/udx-native apps/desktop/dist/win-unpacked/resources/app.asar.unpacked/node_modules/sodium-native
ls -la apps/desktop/dist/GhostLink-Setup-*.exe
```

Write the sizes down for Task 5 (prebuilds of other platforms ship too; trimming them is a later task, not this phase).

---

### Task 5: Full checks and the written result

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md` (§3.1 and a new §12.1)

- [ ] **Step 1: Run everything**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all green. (`apps/server/test/bundle.test.ts` can fail once with EPERM under load on Windows; rerun that file alone before treating it as real.)

- [ ] **Step 2: Record the decision in the spec**

In §3.1, replace the bullet that starts with `- **Onde roda:**` with:

```markdown
- **Onde roda:** no processo principal do Electron. A fase 0 (§12.1) mostrou que os módulos nativos carregam ali, em desenvolvimento e no app empacotado.
```

After the table of §12, add (fill every value from what you measured; no value may stay as a placeholder):

```markdown
### 12.1 Resultado da fase 0 (2026-09-30)

| Verificação | Resultado |
|---|---|
| Testes (`p2pSwarm.test.ts`) sobre DHT local | <passou/falhou, n testes> |
| `npm run smoke:dev` (processo principal real) | <linha final do smoke> |
| `npm run dist` + `npm run smoke` (app empacotado, fuses atuais) | <linha final do smoke> |
| Precisou de `asarUnpack` explícito? | <sim/não> |
| Tamanho somado de `udx-native` + `sodium-native` no pacote | <valor> |
| Tamanho do instalador | <valor> (v0.1.0: <valor do release v0.1.0>) |
| DHT pública, dois nós nesta máquina (prova descartável) | escutar 4,4 s, conectar 2,3 s |

Ainda falta: conexão entre duas redes diferentes, a testar com o dono e um amigo quando a fase 1 tiver tela.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md
git commit -m "docs(spec): phase 0 result: the P2P engine runs in the main process"
```

---

## Self-review

- **Spec coverage (phase 0 of §12):** tests over a local DHT (Task 2), the real main process (Task 3 Step 9), the packaged app with the current fuses (Task 4), the decision about where the engine runs (Task 5). The public-DHT check between two networks is explicitly deferred to Phase 1 with the owner.
- **Types:** `FriendSwarm.start/connectTo/onLink/stop/publicKey` and `FriendLink.remoteKey/send/onData/onClose/close` are used with the same names in the tests, the self-test and the implementation. `SmokeDeps.p2p` is optional in the interface, the tests and `index.ts`.
- **No placeholders:** the only values left to fill are measurements in Task 5 Step 2, which the step requires to be filled from real output.

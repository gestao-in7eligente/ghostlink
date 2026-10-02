// The friends engine as the main process uses it (friends spec §3.1): it follows the identity
// (no usable identity, no engine), keeps "Ficar disponível para amigos", and hands the renderer
// snapshots with a growing revision. A failure to open the database or to start the P2P node
// never reaches the app: the snapshot just says `running: false`.
//
// The database (node:sqlite) and the node (Hyperswarm's native modules) are loaded on first use,
// so neither costs anything, nor can break the start, for someone without an identity.
import { join } from 'node:path';
import type { BootstrapNode } from 'hyperdht';
import { sanitizeLabel } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import type { DmApi, DmEvent } from '../../shared/dmTypes.js';
import { FRIEND_LOCAL_NAME_MAX, type FriendsSnapshot } from '../../shared/friendsTypes.js';
import type { IdentityStore } from '../identity.js';
import type { Log } from '../log.js';
import type { SettingsStore } from '../settings.js';
import { Dm, type DmNotification } from './dm.js';
import { DM_FILES_DIR, DmFiles } from './dmFiles.js';
import { friendKeyFromSeed, keyFromText, sameKey, type FriendKey } from './friendKey.js';
import { Friends, type FriendsNetwork } from './friends.js';
import type { Timers } from './inbox.js';
import type { FriendsStore } from './store.js';
import type { FriendSwarmOptions } from './swarm.js';

/** The P2P node: FriendSwarm in production. */
export type FriendsNode = FriendsNetwork & { listen(): Promise<void>; stop(): Promise<void> };

export interface FriendsEngineDeps {
  identity: Pick<IdentityStore, 'status' | 'friendSeed'>;
  /** The global nickname comes from here. */
  settings: Pick<SettingsStore, 'get'>;
  userDataDir: string;
  /** IPC_EVENTS.friends: called with a new snapshot after every change. */
  emit(snapshot: FriendsSnapshot): void;
  /** IPC_EVENTS.dm: a message or a conversation changed, or a friend is typing. */
  emitDm?(event: DmEvent): void;
  /** A message from a friend arrived: the desktop notification (notifications.ts decides whether it shows). */
  notifyDm?(notification: DmNotification): void;
  /** "Baixar" on a file of a conversation: the system's save dialog, with that name offered; null when cancelled. */
  chooseSavePath?(name: string): Promise<string | null>;
  /** Development only (friendsEnv): a private DHT and the bind address. Default: the public DHT, every interface. */
  bootstrap?: BootstrapNode[];
  bindHost?: string;
  /** Development only (friendsEnv): false keeps the node off whatever the person chose. */
  network?: boolean;
  log?: Pick<Log, 'info' | 'warn' | 'error'>;
  now?: () => number;
  timers?: Timers;
  retryDelayMs?: (attempt: number) => number;
  /** Creates the node; the default loads swarm.ts, and with it the native modules. */
  createNode?: (opts: FriendSwarmOptions) => Promise<FriendsNode>;
}

/** How long a start waits for the node stopped before it to leave the DHT. */
const LEAVE_TIMEOUT_MS = 10_000;

/** window.ghostlink.dm as main serves it (dmIpc.ts); the events go out through `emitDm`. */
export type DmService = Omit<DmApi, 'onEvent'>;

/** One identity at work: its key, its database, its rules and, while available, its node. */
interface Session {
  seed: Uint8Array;
  key: FriendKey;
  store: FriendsStore;
  friends: Friends;
  dm: Dm;
  node: FriendsNode | null;
}

const BOOTSTRAP_NODE = /^([A-Za-z0-9.-]+):(\d{1,5})$/;

/** "host:port,host:port"; undefined when not set, null when it is not such a list. */
function parseBootstrap(value: string | undefined): BootstrapNode[] | null | undefined {
  if (!value) return undefined;
  const nodes: BootstrapNode[] = [];
  for (const entry of value.split(',')) {
    const match = BOOTSTRAP_NODE.exec(entry.trim());
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535) return null;
    nodes.push({ host: match[1]!, port });
  }
  return nodes;
}

/**
 * The development switches, never honoured when packaged:
 * - GHOSTLINK_DHT_BOOTSTRAP="host:port,host:port": a private DHT (hyperdht/testnet) instead of the public one;
 * - GHOSTLINK_P2P_BIND=127.0.0.1: the address the UDP sockets bind to;
 * - GHOSTLINK_P2P=0: the node stays off (the other e2e suites must not touch the network).
 * A bootstrap list that does not parse also keeps the node off: a typo must not join the public DHT.
 */
export function friendsEnv(env: NodeJS.ProcessEnv, packaged: boolean): Pick<FriendsEngineDeps, 'bootstrap' | 'bindHost' | 'network'> {
  if (packaged) return {};
  const bootstrap = parseBootstrap(env.GHOSTLINK_DHT_BOOTSTRAP);
  if (env.GHOSTLINK_P2P === '0' || bootstrap === null) return { network: false };
  return { ...(bootstrap ? { bootstrap } : {}), ...(env.GHOSTLINK_P2P_BIND ? { bindHost: env.GHOSTLINK_P2P_BIND } : {}) };
}

type WatchedIdentity = Pick<IdentityStore, 'status' | 'create' | 'retry' | 'replaceKeepingBackup' | 'exportSeed' | 'importSeed' | 'deleteIdentity'>;

/**
 * The identity as the IPC handlers and the backup use it: `changed` is told after every call
 * that may have changed its status (created, unlocked, locked, imported, deleted), failed or not.
 */
export function watchIdentity(identity: WatchedIdentity, changed: () => void): WatchedIdentity {
  const telling = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
    try {
      return call(...args);
    } finally {
      changed();
    }
  };
  return {
    get status() {
      return identity.status;
    },
    create: telling(() => identity.create()),
    retry: telling(() => identity.retry()),
    replaceKeepingBackup: telling(() => identity.replaceKeepingBackup()),
    exportSeed: () => identity.exportSeed(),
    importSeed: telling((seed) => identity.importSeed(seed)),
    deleteIdentity: telling(() => identity.deleteIdentity()),
  };
}

export class FriendsEngine {
  readonly #d: FriendsEngineDeps;
  readonly #createNode: NonNullable<FriendsEngineDeps['createNode']>;
  #session: Session | null = null;
  #revision = 0;
  /** Calls and identity changes run one after the other. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The node stopped last, on its way out of the DHT. */
  #leaving: Promise<void> = Promise.resolve();

  constructor(deps: FriendsEngineDeps) {
    this.#d = deps;
    this.#createNode = deps.createNode ?? (async (opts) => (await import('./swarm.js')).FriendSwarm.create(opts));
  }

  /** Looks at the identity and the switches again and starts, restarts or stops what they ask for. */
  sync(): Promise<void> {
    return this.#run(() => this.#apply()).then(
      () => {},
      (e: unknown) => this.#d.log?.error('[friends] the engine could not follow the identity:', e),
    );
  }

  /** The app is quitting: closes every link, the node and the database. */
  dispose(): Promise<void> {
    return this.#run(async () => {
      this.#close();
      await this.#leaving;
    }).then(() => {});
  }

  /** The global nickname changed (settings): friends with an open link hear it. */
  nicknameChanged(): void {
    this.#run(() => this.#session?.friends.announceNickname()).catch(() => {});
  }

  // window.ghostlink.friends.

  state(): Promise<FriendsSnapshot> {
    return this.#run(() => {});
  }

  add(code: string): Promise<FriendsSnapshot> {
    return this.#run(() => this.#online().add(code));
  }

  accept(key: string): Promise<FriendsSnapshot> {
    return this.#run(() => this.#online().accept(keyFromText(key)));
  }

  dismiss(key: string): Promise<FriendsSnapshot> {
    return this.#run(() => this.#local().dismiss(keyFromText(key)));
  }

  remove(key: string): Promise<FriendsSnapshot> {
    return this.#run(() => this.#local().remove(keyFromText(key)));
  }

  block(key: string): Promise<FriendsSnapshot> {
    return this.#run(() => this.#local().block(keyFromText(key)));
  }

  rename(key: string, localName: string | null): Promise<FriendsSnapshot> {
    // A local name is shown like a nickname, so it is cleaned like one.
    const name = localName === null ? null : sanitizeLabel(localName, FRIEND_LOCAL_NAME_MAX) || null;
    return this.#run(() => this.#local().rename(keyFromText(key), name));
  }

  newCode(): Promise<FriendsSnapshot> {
    return this.#run(() => this.#local().newCode());
  }

  setInbox(enabled: boolean): Promise<FriendsSnapshot> {
    return this.#run(() => this.#local().setInbox(enabled));
  }

  setAvailable(enabled: boolean): Promise<FriendsSnapshot> {
    return this.#run(async () => {
      this.#local();
      this.#session!.store.setAvailable(enabled);
      await this.#apply();
    });
  }

  /**
   * window.ghostlink.dm (friends spec §4). Reading works on the database alone: conversations
   * (none without an identity), history, the read mark and hiding. Whatever writes an entry or
   * reaches the friend (open, send, edit, remove, typing) needs the node up: P2P_UNAVAILABLE.
   */
  readonly dm: DmService = {
    conversations: () => this.#call(() => this.#session?.dm.conversations() ?? []),
    open: (friendKey) => this.#call(() => this.#dmOnline().open(keyFromText(friendKey))),
    hide: (conv) => this.#call(() => this.#dmLocal().hide(conv)),
    history: (conv, before, limit) => this.#call(() => this.#dmLocal().history(conv, before, limit)),
    send: (conv, text, replyTo, files) => this.#call(() => this.#dmOnline().send(conv, text, replyTo, files)),
    edit: (conv, id, text) => this.#call(() => this.#dmOnline().edit(conv, id, text)),
    remove: (conv, id) => this.#call(() => this.#dmOnline().remove(conv, id)),
    read: (conv, ts) => this.#call(() => this.#dmLocal().read(conv, ts)),
    typing: (conv) => this.#call(() => this.#dmOnline().typing(conv)),
    attach: (conv, name, bytes) => this.#call(() => this.#dmOnline().attach(conv, name, bytes)),
    fetchFile: (conv, hash) => this.#call(() => this.#dmOnline().fetchFile(conv, hash)),
    // The dialog waits outside the queue: other calls go on while the person picks a folder.
    saveFile: async (conv, hash) => {
      const name = await this.#call(() => this.#dmLocal().savable(conv, hash));
      const destination = await this.#d.chooseSavePath?.(name);
      if (!destination) return false;
      await this.#call(() => this.#dmLocal().saveTo(conv, hash, destination));
      return true;
    },
  };

  /** app://ghostlink/_dmfile/<hash>: where that file is, when a message here carries it and it is here. */
  dmFile(hash: string): string | null {
    return this.#session?.dm.servable(hash) ?? null;
  }

  // Inside.

  /** Runs `step` after everything queued before it and answers with the snapshot that follows it. */
  #run(step: () => unknown): Promise<FriendsSnapshot> {
    return this.#call(async () => {
      await step();
      return this.#snapshot();
    });
  }

  /** Runs `step` after everything queued before it and answers with what it returns. */
  #call<T>(step: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(step);
    this.#queue = result.catch(() => {});
    return result;
  }

  #dmLocal(): Dm {
    if (!this.#session) throw new AppError('P2P_UNAVAILABLE');
    return this.#session.dm;
  }

  #dmOnline(): Dm {
    if (!this.#session?.node) throw new AppError('P2P_UNAVAILABLE');
    return this.#session.dm;
  }

  /** The rules, for what only touches this computer: needs the identity, not the network. */
  #local(): Friends {
    if (!this.#session) throw new AppError('P2P_UNAVAILABLE');
    return this.#session.friends;
  }

  /** The rules, for what is pointless without the network (a request, an answer). */
  #online(): Friends {
    if (!this.#session?.node) throw new AppError('P2P_UNAVAILABLE');
    return this.#session.friends;
  }

  #snapshot(): FriendsSnapshot {
    const s = this.#session;
    return {
      revision: this.#revision,
      running: s?.node != null,
      available: s ? s.store.me.available : true,
      code: s ? s.friends.code() : null,
      inboxEnabled: s ? s.store.me.inboxEnabled : true,
      friends: s ? s.friends.list() : [],
    };
  }

  #changed(): void {
    this.#revision++;
    this.#d.emit(this.#snapshot());
  }

  async #apply(): Promise<void> {
    const seed = this.#friendSeed();
    const current = this.#session;
    if (current && (!seed || !sameKey(friendKeyFromSeed(seed).publicKey, current.key.publicKey))) this.#close();
    if (seed && !this.#session) await this.#open(seed);
    else seed?.fill(0);
    const session = this.#session;
    if (session) {
      const wanted = this.#d.network !== false && session.store.me.available;
      if (!wanted) this.#stopNode(session);
      else if (!session.node) await this.#startNode(session);
    }
    this.#changed();
  }

  #friendSeed(): Uint8Array | null {
    if (this.#d.identity.status !== 'ready') return null;
    try {
      return this.#d.identity.friendSeed();
    } catch {
      return null;
    }
  }

  async #open(seed: Uint8Array): Promise<void> {
    try {
      const { FriendsStore } = await import('./store.js');
      const key = friendKeyFromSeed(seed);
      const store = FriendsStore.open(this.#d.userDataDir, key.publicKey);
      const dm = new Dm({
        store,
        key,
        files: new DmFiles(join(this.#d.userDataDir, DM_FILES_DIR)),
        emit: (event) => this.#d.emitDm?.(event),
        notify: (notification) => this.#d.notifyDm?.(notification),
        now: this.#d.now,
        timers: this.#d.timers,
      });
      const friends = new Friends({
        store,
        key,
        nickname: () => this.#d.settings.get().nickname,
        onChange: () => this.#changed(),
        log: this.#d.log,
        now: this.#d.now,
        timers: this.#d.timers,
        retryDelayMs: this.#d.retryDelayMs,
        traffic: dm,
      });
      this.#session = { seed, key, store, friends, dm, node: null };
    } catch (e) {
      this.#d.log?.error('[friends] the friends database could not be opened:', e);
    }
  }

  async #startNode(session: Session): Promise<void> {
    // Two nodes with one key must not overlap: the old one's goodbye would erase the new one's announcement.
    await this.#leaving;
    let node: FriendsNode | null = null;
    try {
      node = await this.#createNode({
        seed: session.seed,
        allow: (remoteKey) => session.friends.allows(remoteKey),
        bootstrap: this.#d.bootstrap,
        bindHost: this.#d.bindHost,
      });
      session.friends.attach(node);
      session.node = node;
    } catch (e) {
      // No network stack (a native module did not load, no socket): the app goes on without friends online.
      this.#d.log?.error('[friends] the P2P engine did not start:', e);
      session.friends.detach();
      node?.stop().catch(() => {});
      return;
    }
    // Announcing takes seconds on the public DHT; the node already reaches out meanwhile.
    const started = node;
    started.listen().catch((e: unknown) => {
      if (session.node !== started) return; // stopped meanwhile
      this.#d.log?.error('[friends] the P2P engine could not announce itself:', e);
      this.#stopNode(session);
      this.#changed();
    });
  }

  #stopNode(session: Session): void {
    const node = session.node;
    if (!node) return;
    session.node = null;
    session.friends.detach();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, LEAVE_TIMEOUT_MS).unref());
    this.#leaving = Promise.race([node.stop().catch((e: unknown) => this.#d.log?.warn('[friends] the P2P node did not stop cleanly:', e)), timeout]).then(() => {});
  }

  #close(): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    this.#stopNode(session);
    // No timer of the conversations may touch the database once it is closed.
    session.dm.dispose();
    session.store.close();
    session.seed.fill(0);
  }
}

// End to end below the UI: a real server with the text module, two desktop clients
// (the real ClientController over pinned WSS), and each client's server events
// applied to its own copy of the renderer's text reducer, exactly as the app does.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, has, messageSchemaClient, type Envelope, type Message } from '@ghostlink/shared';
import { createTextModule } from '../../../server/src/text/index.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import type { ConnectionStateEvent, RendererWelcome } from '../../src/shared/ipcTypes.js';
import { ClientController } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { parseTextEvent, snapshotFromWelcome } from '../../src/renderer/features/chat/events.js';
import { notificationFor } from '../../src/renderer/features/chat/notify.js';
import { translate } from '../../src/renderer/i18n/index.js';
import { readMark, sortedChannels } from '../../src/renderer/stores/channels.js';
import { canActOnMember, myPermissions } from '../../src/renderer/stores/server.js';
import { initialText, textReducer, type TextState } from '../../src/renderer/stores/text.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** One running app: its controller, what main forwarded to the renderer, and the renderer's text state. */
interface App {
  controller: ClientController;
  events: Envelope[];
  states: ConnectionStateEvent[];
  welcome: RendererWelcome;
  /** Applies every forwarded event not applied yet, like useTextSync does. */
  sync(): TextState;
  state: TextState;
  request<T>(type: string, payload: Record<string, unknown>): Promise<T>;
  /** Loads a channel's newest page into the state, like opening it in the UI. */
  open(channelId: string): Promise<void>;
}

async function textServer(): Promise<TestServer> {
  const t = await startTestServer({
    modules: [createTextModule()],
    limits: { newIdentitiesPerIpPerHour: 1_000, requestsPerSecondPerSession: 10_000, presenceGraceMs: 50 },
  });
  cleanups.push(() => t.cleanup());
  return t;
}

async function launch(t: TestServer, name: string, nickname: string, extra: { setupCode?: string } = {}): Promise<App> {
  const userData = join(dir.path, name);
  mkdirSync(userData, { recursive: true });
  const identity = IdentityStore.load(userData, new FakeSafeStorage());
  identity.create();
  const events: Envelope[] = [];
  const states: ConnectionStateEvent[] = [];
  const controller = new ClientController({
    identity,
    settings: SettingsStore.load(userData, 'pt-BR'),
    servers: SavedServersStore.load(userData),
    setRendererPins: async () => {},
    emitConnectionState: (e) => states.push(e),
    emitServerEvent: (e) => events.push(e),
    clientName: 'ghostlink/0.1.0 (test)',
  });
  cleanups.push(() => controller.disconnect());
  const parsed = controller.parse(t.server.createInvite().link);
  if (parsed.kind !== 'invite') throw new Error('expected an invite');
  const welcome = await controller.join({ ...parsed.invite, nickname, ...extra });
  let applied = 0;
  const app: App = {
    controller,
    events,
    states,
    welcome,
    state: textReducer(initialText, { type: 'reset', snapshot: snapshotFromWelcome(welcome) }),
    sync() {
      for (; applied < events.length; applied += 1) {
        const event = parseTextEvent(events[applied]!);
        if (event) app.state = textReducer(app.state, { type: 'event', event, now: Date.now() });
      }
      return app.state;
    },
    request: async <T>(type: string, payload: Record<string, unknown>) => (await controller.request(type, payload)) as T,
    async open(channelId) {
      app.state = textReducer(app.state, { type: 'history.start', channelId, older: false });
      const page = await app.request<{ messages: unknown[]; hasMore: boolean }>('msg.history', { channelId, limit: 50 });
      const messages = page.messages.map((m) => messageSchemaClient.parse(m));
      app.state = textReducer(app.state, { type: 'history.done', channelId, older: false, messages, hasMore: page.hasMore });
    },
  };
  return app;
}

/** Waits until every event the server sent before now has been forwarded (a ping round trip). */
async function settle(...apps: App[]): Promise<void> {
  for (const a of apps) await a.request('ping', {});
}

const geralOf = (s: TextState) => sortedChannels(s.channels.byId, 'text').find((c) => c.name === 'geral')!.id;
const texts = (s: TextState, channelId: string) => (s.messages.logs[channelId]?.items ?? []).map((m) => m.content);

describe('live text between two apps (server + main + renderer reducers)', () => {
  it('a new member joins by invite and lands in #geral; the owner sees them join', async () => {
    const t = await textServer();
    const ana = await launch(t, 'ana', 'Ana', { setupCode: t.server.setupCode()! });
    const bia = await launch(t, 'bia', 'Bia');
    await settle(ana, bia);
    expect(bia.state.channels.byId[bia.state.channels.activeId!]!.name).toBe('geral');
    expect(Object.values(ana.sync().members.byId).map((m) => m.nickname).sort()).toEqual(['Ana', 'Bia']);
    expect(ana.state.server.ownerId).toBe(ana.welcome.self.userId);
    expect(myPermissions(bia.state) & PERMISSIONS.MANAGE_CHANNELS).toBe(0);
  });

  it('chat is live both ways, with pending sends, unread marks and a mention notification', async () => {
    const t = await textServer();
    const ana = await launch(t, 'ana', 'Ana', { setupCode: t.server.setupCode()! });
    const bia = await launch(t, 'bia', 'Bia');
    const geral = geralOf(ana.state);
    await ana.open(geral);
    await bia.open(geral);

    // Bia writes (as the composer does: pending first, then msg.send).
    bia.state = textReducer(bia.state, { type: 'pending.add', pending: { clientMsgId: 'b1', channelId: geral, content: 'Oi, Ana!', replyTo: null, createdAt: Date.now(), error: null } });
    const sent = await bia.request<{ message: Message }>('msg.send', { channelId: geral, content: 'Oi, Ana!', clientMsgId: 'b1' });
    await settle(ana, bia);
    expect(texts(bia.sync(), geral)).toEqual(['Oi, Ana!']);
    expect(bia.state.messages.logs[geral]!.pending).toEqual([]);
    expect(texts(ana.sync(), geral)).toEqual(['Oi, Ana!']);
    // Ana was not looking: #geral is unread for her, read for Bia (her own message).
    expect(ana.state.channels.byId[geral]!.lastMessageId).toBe(sent.message.id);
    expect(readMark(ana.state.channels, geral).lastReadMessageId).toBeLessThan(sent.message.id);
    expect(readMark(bia.state.channels, geral).lastReadMessageId).toBe(sent.message.id);

    // Bia mentions Ana: a mention count and a notification for Ana.
    const anaId = ana.welcome.self.userId;
    await bia.request('msg.send', { channelId: geral, content: `<@${anaId}> olha isso`, clientMsgId: 'b2' });
    await settle(ana, bia);
    ana.sync();
    expect(readMark(ana.state.channels, geral).mentionCount).toBe(1);
    const last = ana.state.messages.logs[geral]!.items.at(-1)!;
    const note = notificationFor(ana.state, last, (k, v) => translate('pt-BR', k, v), 'mentions');
    expect(note).toEqual({ server: ana.state.server.name, channel: 'geral', author: 'Bia', body: '@Ana olha isso', serverIcon: null, channelId: geral });

    // Ana reads the channel: the mention count goes back to 0.
    const read = await ana.request<{ readState: { channelId: string; lastReadMessageId: number; mentionCount: number; unreadCount: number } }>('channel.read', { channelId: geral, messageId: last.id });
    ana.state = textReducer(ana.state, { type: 'read', readState: read.readState });
    expect(readMark(ana.state.channels, geral)).toEqual({ lastReadMessageId: last.id, mentionCount: 0, unreadCount: 0 });

    // Ana replies, reacts and edits; Bia sees all of it.
    await ana.request('msg.send', { channelId: geral, content: 'Vi!', clientMsgId: 'a1', replyTo: last.id });
    await ana.request('msg.react', { id: last.id, emoji: '👍' });
    // Only the author edits (spec §5.2).
    await expect(ana.request('msg.edit', { id: sent.message.id, content: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await settle(ana, bia);
    bia.sync();
    const replied = bia.state.messages.logs[geral]!.items.at(-1)!;
    expect(replied.content).toBe('Vi!');
    expect(replied.replyTo).toMatchObject({ id: last.id, deleted: false });
    expect(bia.state.messages.logs[geral]!.items.find((m) => m.id === last.id)!.reactions).toEqual([{ emoji: '👍', userIds: [anaId] }]);
    expect(notificationFor(bia.state, replied, (k, v) => translate('pt-BR', k, v), 'mentions')).toMatchObject({ author: 'Ana', body: 'Vi!', channel: 'geral' });
  });

  it('a private channel created by the owner never reaches a plain member', async () => {
    const t = await textServer();
    const ana = await launch(t, 'ana', 'Ana', { setupCode: t.server.setupCode()! });
    const bia = await launch(t, 'bia', 'Bia');
    const { channel } = await ana.request<{ channel: { id: string } }>('channel.create', { name: 'segredo', type: 'text', private: true });
    await ana.request('msg.send', { channelId: channel.id, content: 'só para a equipe', clientMsgId: 'a1' });
    await ana.request('typing', { channelId: channel.id });
    await settle(ana, bia);
    expect(sortedChannels(ana.sync().channels.byId, 'text').map((c) => c.name)).toContain('segredo');
    expect(sortedChannels(bia.sync().channels.byId, 'text').map((c) => c.name)).not.toContain('segredo');
    expect(JSON.stringify(bia.events)).not.toContain(channel.id);
    await expect(bia.request('msg.history', { channelId: channel.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(bia.request('msg.send', { channelId: channel.id, content: 'oi', clientMsgId: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('kick ends the session with KICKED, removes the member, and a saved-server reconnect is refused', async () => {
    const t = await textServer();
    const ana = await launch(t, 'ana', 'Ana', { setupCode: t.server.setupCode()! });
    const bia = await launch(t, 'bia', 'Bia');
    await settle(ana, bia);
    const biaId = bia.welcome.self.userId;
    expect(canActOnMember(ana.sync(), biaId)).toBe(true);
    expect(canActOnMember(bia.sync(), ana.welcome.self.userId)).toBe(false);
    await ana.request('member.kick', { userId: biaId });
    await waitFor(() => bia.states.some((s) => s.state === 'failed'));
    expect(bia.states.at(-1)).toMatchObject({ state: 'failed', error: 'KICKED' });
    await settle(ana);
    expect(ana.sync().members.byId[biaId]).toBeUndefined();
    await expect(bia.controller.connectSaved(bia.welcome.serverId)).rejects.toMatchObject({ code: expect.stringMatching(/^(REJOIN_BLOCKED|INVITE_REQUIRED)$/) });
  });

  it('ban blocks for good; the owner still has every permission in the UI', async () => {
    const t = await textServer();
    const ana = await launch(t, 'ana', 'Ana', { setupCode: t.server.setupCode()! });
    const bia = await launch(t, 'bia', 'Bia');
    await settle(ana, bia);
    expect(has(myPermissions(ana.sync()), PERMISSIONS.BAN_MEMBERS)).toBe(true);
    await ana.request('member.ban', { userId: bia.welcome.self.userId, reason: 'spam' });
    await waitFor(() => bia.states.some((s) => s.state === 'failed'));
    expect(bia.states.at(-1)).toMatchObject({ state: 'failed', error: 'BANNED' });
    const { bans } = await ana.request<{ bans: { nickname: string; reason: string }[] }>('bans.list', {});
    expect(bans).toMatchObject([{ nickname: 'Bia', reason: 'spam' }]);
  });
});

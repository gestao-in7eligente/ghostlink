import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextSnapshot } from '../../src/renderer/features/chat/events.js';
import { averageColor, cardRoles, formatMemberSince, nextRoleIds, placeCard, type CardRoles } from '../../src/renderer/features/profileCard/profileCardModel.js';
import { changeRole, copyUserId, useProfileCardStore } from '../../src/renderer/features/profileCard/profileCardStore.js';
import { initialConnection, useConnectionStore } from '../../src/renderer/stores/connection.js';
import { initialText, useTextStore } from '../../src/renderer/stores/text.js';
import { ADMIN_ROLE, BOB, CAROL, FANS_ROLE, ME, MOD_ROLE, OWNER, member, snapshot, start, welcomeWithText } from './textFixtures.js';

describe('the banner color: the mean of the photo\'s opaque pixels (spec §2 item 1)', () => {
  it('averages the opaque pixels of RGBA data', () => {
    expect(averageColor([255, 0, 0, 255, 0, 0, 255, 255])).toBe('#800080');
    expect(averageColor(new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 200]))).toBe('#0a141e');
  });

  it('leaves transparent pixels out, and gives null when nothing is opaque (the initials\' color then)', () => {
    expect(averageColor([255, 255, 255, 0, 255, 255, 255, 127, 0, 64, 128, 255])).toBe('#004080');
    expect(averageColor([255, 255, 255, 0])).toBeNull();
    expect(averageColor([])).toBeNull();
  });
});

describe('where the card goes (spec §1)', () => {
  const size = { width: 340, height: 300 };
  const viewport = { width: 1280, height: 800 };

  it('to the right of a name in the chat, its top level with the name', () => {
    expect(placeCard({ left: 100, top: 200, right: 160, bottom: 220 }, size, viewport, 'right')).toEqual({ left: 168, top: 200 });
  });

  it('to the left of a member row', () => {
    expect(placeCard({ left: 1040, top: 300, right: 1264, bottom: 344 }, size, viewport, 'left')).toEqual({ left: 692, top: 300 });
  });

  it('flips to the other side when its own has no room', () => {
    expect(placeCard({ left: 1000, top: 100, right: 1100, bottom: 120 }, size, viewport, 'right')).toEqual({ left: 652, top: 100 });
    expect(placeCard({ left: 100, top: 100, right: 300, bottom: 140 }, size, viewport, 'left')).toEqual({ left: 308, top: 100 });
  });

  it('always stays inside the window', () => {
    // Near the bottom: it moves up.
    expect(placeCard({ left: 100, top: 700, right: 160, bottom: 720 }, size, viewport, 'right')).toEqual({ left: 168, top: 492 });
    // No room on either side: clamped.
    expect(placeCard({ left: 150, top: 10, right: 250, bottom: 30 }, size, { width: 400, height: 800 }, 'right')).toEqual({ left: 52, top: 10 });
    // Taller than the window: its top stays on screen.
    expect(placeCard({ left: 100, top: 300, right: 160, bottom: 320 }, { width: 340, height: 1000 }, viewport, 'right').top).toBe(8);
  });
});

describe('the roles on the card: × and (+) only for who may manage them (spec §2 item 5)', () => {
  // Admin (3) > Mods (2, MANAGE_ROLES) > Fãs (1); Dona owns the server.
  const people = (meRoles: string[], extra: Partial<TextSnapshot['text']> = {}) =>
    start(
      snapshot({
        members: [member(ME, 'Eu', { roleIds: meRoles }), member(BOB, 'Bob'), member(CAROL, 'Carol', { roleIds: [FANS_ROLE, MOD_ROLE] }), member(OWNER, 'Dona', { roleIds: [ADMIN_ROLE] })],
        ...extra,
      }),
    );
  const ids = (roles: readonly { id: string }[]) => roles.map((r) => r.id);
  /** What I may do on the card: the roles with an ×, and the "(+)" menu. */
  const managed = (view: CardRoles) => ({ removable: [...view.removable].sort(), addable: ids(view.addable) });
  const nothing = { removable: [], addable: [] };

  it('MANAGE_ROLES above the person: × on their roles below mine, (+) with the ones below mine they lack', () => {
    const mod = people([MOD_ROLE]);
    const bob = cardRoles(mod, mod.members.byId[BOB]!);
    expect(bob.roles).toEqual([]);
    expect(managed(bob)).toEqual({ removable: [], addable: [FANS_ROLE] });
    // With Admin above Mods, both of Carol's roles are below mine.
    const admin = people([MOD_ROLE, ADMIN_ROLE]);
    const carol = cardRoles(admin, admin.members.byId[CAROL]!);
    expect(ids(carol.roles)).toEqual([MOD_ROLE, FANS_ROLE]);
    expect(managed(carol)).toEqual({ removable: [FANS_ROLE, MOD_ROLE].sort(), addable: [] });
  });

  it('nobody else gets them: without the permission, on someone level or above, on the owner, on myself', () => {
    const fan = people([FANS_ROLE]);
    expect(managed(cardRoles(fan, fan.members.byId[BOB]!))).toEqual(nothing);
    const mod = people([MOD_ROLE]);
    const carol = cardRoles(mod, mod.members.byId[CAROL]!); // Mods too: level with me
    expect(ids(carol.roles)).toEqual([MOD_ROLE, FANS_ROLE]);
    expect(managed(carol)).toEqual(nothing);
    expect(managed(cardRoles(mod, mod.members.byId[OWNER]!))).toEqual(nothing);
    const me = cardRoles(mod, mod.members.byId[ME]!);
    expect(ids(me.roles)).toEqual([MOD_ROLE]);
    expect(managed(me)).toEqual(nothing);
  });

  it('the owner may give every role, strongest first', () => {
    const owner = people([], { serverSettings: { ...snapshot().text.serverSettings, ownerId: ME } });
    expect(managed(cardRoles(owner, owner.members.byId[BOB]!))).toEqual({ removable: [], addable: [ADMIN_ROLE, MOD_ROLE, FANS_ROLE] });
  });

  it('member.setRoles gets the whole list with one role more or less', () => {
    expect(nextRoleIds([MOD_ROLE], FANS_ROLE, true)).toEqual([MOD_ROLE, FANS_ROLE]);
    expect(nextRoleIds([MOD_ROLE, FANS_ROLE], FANS_ROLE, true)).toEqual([MOD_ROLE, FANS_ROLE]);
    expect(nextRoleIds([MOD_ROLE, FANS_ROLE], MOD_ROLE, false)).toEqual([FANS_ROLE]);
  });
});

describe('the rest of the card', () => {
  it('"MEMBRO DESDE" in the app\'s language; nothing when the server did not say', () => {
    const at = Date.UTC(2026, 9, 2, 12);
    expect(formatMemberSince(at, 'pt-BR')).toBe('2 de out. de 2026');
    expect(formatMemberSince(at, 'en')).toBe('Oct 2, 2026');
    expect(formatMemberSince(0, 'pt-BR')).toBeNull();
  });
});

// ---- the store and the card's buttons ----

function fakeApi() {
  return {
    app: { copyText: vi.fn(async (_text: string) => undefined) },
    server: { request: vi.fn(async (_type: string, _payload?: unknown, _serverId?: string): Promise<unknown> => ({})) },
  };
}

let api: ReturnType<typeof fakeApi>;
const rect = (left: number, top: number) => ({ left, top, right: left + 60, bottom: top + 20, width: 60, height: 20, x: left, y: top });
const opener = () => ({ isConnected: true, focus: vi.fn() });

beforeEach(() => {
  api = fakeApi();
  vi.stubGlobal('window', { ghostlink: api });
  useTextStore.setState(initialText);
  useTextStore.getState().dispatch({ type: 'reset', snapshot: snapshot() });
  useProfileCardStore.setState({ card: null });
  useConnectionStore.setState({ ...initialConnection, state: 'connected', serverId: 'srv-1', welcome: welcomeWithText() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opening and closing the card (spec §1)', () => {
  it('opens beside the clicked name, for the server on screen', () => {
    const name = opener();
    useProfileCardStore.getState().open(BOB, rect(100, 200), 'right', name);
    expect(useProfileCardStore.getState().card).toMatchObject({
      serverId: 'srv-1',
      userId: BOB,
      anchor: { left: 100, top: 200, right: 160, bottom: 220 },
      side: 'right',
      opener: name,
    });
  });

  it('one at a time: another person\'s card replaces it; the same name clicked again closes it', () => {
    const store = useProfileCardStore.getState();
    const bobName = opener();
    store.open(BOB, rect(100, 200), 'right', bobName);
    const first = useProfileCardStore.getState().card!;
    store.open(CAROL, rect(1040, 300), 'left', opener());
    const second = useProfileCardStore.getState().card!;
    expect(second).toMatchObject({ userId: CAROL, side: 'left' });
    expect(second.id).not.toBe(first.id);
    // The same person from somewhere else moves the card there.
    const carolRow = opener();
    store.open(CAROL, rect(1040, 340), 'left', carolRow);
    expect(useProfileCardStore.getState().card).toMatchObject({ userId: CAROL, anchor: { top: 340 } });
    store.open(CAROL, rect(1040, 340), 'left', carolRow);
    expect(useProfileCardStore.getState().card).toBeNull();
  });

  it('closes', () => {
    useProfileCardStore.getState().open(BOB, rect(100, 200), 'right', opener());
    useProfileCardStore.getState().close();
    expect(useProfileCardStore.getState().card).toBeNull();
  });
});

describe('what the card\'s buttons do', () => {
  it('"Copiar ID do usuário" hands the id to main', async () => {
    await copyUserId(BOB);
    expect(api.app.copyText).toHaveBeenCalledWith(BOB);
  });

  it('× and (+) send the whole role list with member.setRoles to the server on screen', async () => {
    api.server.request.mockImplementation(async (_type, payload) => ({ member: member(BOB, 'Bob', { roleIds: (payload as { roleIds: string[] }).roleIds }) }));
    await changeRole(member(BOB, 'Bob', { roleIds: [MOD_ROLE] }), FANS_ROLE, true);
    expect(api.server.request).toHaveBeenLastCalledWith('member.setRoles', { userId: BOB, roleIds: [MOD_ROLE, FANS_ROLE] }, 'srv-1');
    await changeRole(member(BOB, 'Bob', { roleIds: [MOD_ROLE, FANS_ROLE] }), MOD_ROLE, false);
    expect(api.server.request).toHaveBeenLastCalledWith('member.setRoles', { userId: BOB, roleIds: [FANS_ROLE] }, 'srv-1');
  });

  it('a refused role change rejects with the server\'s code (shown on one line)', async () => {
    api.server.request.mockRejectedValue(new Error('HIERARCHY'));
    await expect(changeRole(member(BOB, 'Bob'), FANS_ROLE, true)).rejects.toThrow('HIERARCHY');
  });
});

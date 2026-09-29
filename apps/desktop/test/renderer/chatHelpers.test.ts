import { describe, expect, it } from 'vitest';
import { CHAT_LIMITS } from '@ghostlink/shared';
import { buildRows, formatDay, formatStamp } from '../../src/renderer/features/chat/grouping.js';
import {
  applyMention,
  decodeMentions,
  encodeMentions,
  everyoneCandidate,
  mentionQueryAt,
  mentionSuggestions,
  roleCandidate,
  userCandidate,
} from '../../src/renderer/features/chat/mentions.js';
import { notificationFor } from '../../src/renderer/features/chat/notify.js';
import { translate, type Translate } from '../../src/renderer/i18n/index.js';
import { ADMIN_ROLE, BOB, CAROL, FANS_ROLE, GERAL, ME, MOD_ROLE, ROLES, ev, member, message, role, run, start } from './textFixtures.js';

const t: Translate = (key, vars) => translate('pt-BR', key, vars);
const T0 = new Date(2026, 8, 19, 9, 36).getTime();
const at = (minutes: number) => T0 + minutes * 60_000;

describe('buildRows: grouping and date separators', () => {
  it('groups one author within 5 minutes and starts a new group otherwise', () => {
    const rows = buildRows(
      [
        message(1, { authorId: BOB, createdAt: at(0) }),
        message(2, { authorId: BOB, createdAt: at(4) }),
        message(3, { authorId: BOB, createdAt: at(4) + CHAT_LIMITS.groupWindowMs }),
        message(4, { authorId: CAROL, createdAt: at(10) }),
        message(5, { authorId: CAROL, createdAt: at(11), replyTo: { id: 4, authorId: CAROL, content: 'x', deleted: false } }),
      ],
      [],
      ME,
    );
    expect(rows.map((r) => (r.kind === 'date' ? 'date' : `${r.key}${r.head ? '*' : ''}`))).toEqual(['date', 'm:1*', 'm:2', 'm:3*', 'm:4*', 'm:5*']);
  });

  it('adds a separator for each new local day, which also starts a group', () => {
    const rows = buildRows([message(1, { createdAt: at(0) }), message(2, { createdAt: at(24 * 60) })], [], ME);
    expect(rows.map((r) => r.kind)).toEqual(['date', 'message', 'date', 'message']);
    expect(rows.every((r) => r.kind === 'date' || r.head)).toBe(true);
  });

  it('shows pending sends after the loaded messages, grouped with my last message', () => {
    const pending = { clientMsgId: 'p1', channelId: GERAL, content: 'oi', replyTo: null, createdAt: at(1), error: null };
    const rows = buildRows([message(1, { authorId: ME, createdAt: at(0) })], [pending], ME);
    expect(rows.at(-1)).toMatchObject({ kind: 'pending', key: 'p:p1', head: false });
  });
});

describe('dates are localized', () => {
  it('formats the separator and the timestamp like the reference', () => {
    expect(formatDay(T0, 'pt-BR')).toBe('19 de setembro de 2026');
    expect(formatStamp(T0, 'pt-BR')).toBe('19/09/2026 09:36');
    expect(formatDay(T0, 'en')).toBe('September 19, 2026');
  });
});

describe('mention autocomplete', () => {
  const members = [member(BOB, 'Bob'), member(CAROL, 'Carolina', { online: false }), member(ME, 'Élis')];

  it('finds the @query before the caret only at a word start', () => {
    expect(mentionQueryAt('oi @bo', 6)).toEqual({ start: 3, query: 'bo' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('mail@bo', 7)).toBeNull();
    expect(mentionQueryAt('@bo b', 5)).toBeNull();
    expect(mentionQueryAt(`@${'x'.repeat(40)}`, 41)).toBeNull();
  });

  it('suggests members (accent-insensitive), mentionable roles and @todos only with MENTION_EVERYONE', () => {
    const src = { members, roles: ROLES, canMentionEveryone: false, everyoneLabel: '@todos' };
    expect(mentionSuggestions('eli', src).map((c) => c.display)).toEqual(['@Élis']);
    expect(mentionSuggestions('', src).map((c) => c.display)).toEqual(['@Bob', '@Élis', '@Carolina', '@Fãs']);
    expect(mentionSuggestions('to', src)).toEqual([]);
    const admin = { ...src, canMentionEveryone: true };
    expect(mentionSuggestions('to', admin)).toEqual([everyoneCandidate('@todos')]);
    expect(mentionSuggestions('every', admin)).toEqual([everyoneCandidate('@todos')]);
    expect(mentionSuggestions('mod', admin).map((c) => c.token)).toEqual([`<@&${MOD_ROLE}>`]);
    expect(mentionSuggestions('lina', src).map((c) => c.display)).toEqual(['@Carolina']);
  });

  it('inserts the display and encodes only picked mentions, outside code', () => {
    const bob = userCandidate(member(BOB, 'Bob'));
    const applied = applyMention('oi @b tudo', 3, 5, bob);
    expect(applied).toEqual({ text: 'oi @Bob  tudo', caret: 8 });
    expect(encodeMentions('oi @Bob, @Bobby e `@Bob` e @Carol', [bob])).toBe(`oi <@${BOB}>, @Bobby e \`@Bob\` e @Carol`);
    const ana = userCandidate(member(CAROL, 'Ana'));
    const anaClara = userCandidate(member(ME, 'Ana Clara'));
    expect(encodeMentions('@Ana Clara e @Ana', [ana, anaClara])).toBe(`<@${ME}> e <@${CAROL}>`);
    expect(encodeMentions('@todos atenção', [everyoneCandidate('@todos')])).toBe('@everyone atenção');
  });

  it('never re-matches inside a token it produced', () => {
    const hexNick = userCandidate(member(BOB, BOB)); // a nickname that equals an id
    expect(encodeMentions(`@${BOB}`, [hexNick])).toBe(`<@${BOB}>`);
  });

  it('decodes tokens for editing and re-encodes them identically', () => {
    const lookup = {
      member: (id: string) => [member(BOB, 'Bob')].find((m) => m.userId === id),
      role: (id: string) => [role(FANS_ROLE, 'Fãs', 1)].find((r) => r.id === id),
      everyoneLabel: '@todos',
    };
    const content = `<@${BOB}> <@&${FANS_ROLE}> @everyone <@${CAROL}> \`<@${BOB}>\``;
    const { text, picked } = decodeMentions(content, lookup);
    expect(text).toBe(`@Bob @Fãs @todos <@${CAROL}> \`<@${BOB}>\``);
    expect(picked.map((c) => c.kind).sort()).toEqual(['everyone', 'role', 'user']);
    expect(encodeMentions(text, picked)).toBe(content);
    expect(roleCandidate(role(ADMIN_ROLE, 'Admin', 3)).token).toBe(`<@&${ADMIN_ROLE}>`);
  });
});

describe('notifications (spec §11.1 item 8)', () => {
  const state = run(start(), ev({ t: 'member.updated', member: member(ME, 'Eu', { roleIds: [FANS_ROLE] }) }));

  it('notifies mentions of me, my roles and @everyone, with plain text', () => {
    const n = notificationFor(state, message(20, { content: `**oi** <@${ME}>`, mentions: { users: [ME], roles: [], everyone: false } }), t);
    expect(n).toEqual({ title: 'Bob mencionou você em #geral', body: 'oi @Eu', channelId: GERAL });
    expect(notificationFor(state, message(21, { mentions: { users: [], roles: [FANS_ROLE], everyone: false } }), t)).not.toBeNull();
    expect(notificationFor(state, message(22, { mentions: { users: [], roles: [], everyone: true } }), t)).not.toBeNull();
  });

  it('notifies replies to me', () => {
    const n = notificationFor(state, message(20, { replyTo: { id: 3, authorId: ME, content: 'x', deleted: false } }), t);
    expect(n?.title).toBe('Bob respondeu você em #geral');
  });

  it('stays quiet for my own messages, ordinary messages and unknown channels', () => {
    expect(notificationFor(state, message(20, { authorId: ME, mentions: { users: [ME], roles: [], everyone: true } }), t)).toBeNull();
    expect(notificationFor(state, message(21), t)).toBeNull();
    expect(notificationFor(state, message(22, { channelId: 'Q'.repeat(26), mentions: { users: [ME], roles: [], everyone: false } }), t)).toBeNull();
  });
});

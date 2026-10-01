import {
  CHAT_LIMITS,
  PERMISSIONS,
  ProtocolError,
  channelCreateSchema,
  channelDeleteSchema,
  channelReadSchema,
  channelReorderSchema,
  channelUpdateSchema,
  sanitizeLabel,
  type ChannelType,
} from '@ghostlink/shared';
import type { RequestContext } from '../../modules.js';
import type { TextCore } from '../core.js';
import { newEntityId } from '../repo.js';

type Handler = (core: TextCore, ctx: RequestContext, payload: unknown) => unknown;

/** Text channels read like Discord's: lowercase, no spaces. Voice channels keep their name. */
export function cleanChannelName(raw: string, type: ChannelType): string {
  const label = sanitizeLabel(raw, CHAT_LIMITS.channelNameMax);
  if (type === 'voice') return label;
  return label.toLocaleLowerCase('pt-BR').replace(/\s+/gu, '-').replace(/^#+/, '');
}

function cleanTopic(raw: string): string {
  return sanitizeLabel(raw.replace(/\s+/gu, ' '), CHAT_LIMITS.topicMax);
}

/** Allowed roles must exist and never be `@everyone` (its id would grant nothing, spec §6). */
function checkAllowedRoles(core: TextCore, ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const role = core.repo.role(id);
    if (!role || role.is_default === 1) throw new ProtocolError('BAD_REQUEST', 'unknown role in allowedRoleIds');
  }
  return unique;
}

const create: Handler = (core, ctx, payload) => {
  const p = channelCreateSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_CHANNELS);
  const name = cleanChannelName(p.name, p.type);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty channel name');
  if (p.type === 'text' && (p.userLimit ?? 0) !== 0) throw new ProtocolError('BAD_REQUEST', 'userLimit is for voice channels');
  const allowed = checkAllowedRoles(core, p.allowedRoleIds ?? []);
  const count = core.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM channels');
  if (Number(count?.n ?? 0) >= core.maxChannels) throw new ProtocolError('BAD_REQUEST', 'too many channels');
  const id = newEntityId();
  const { db } = core;
  // A new channel is "gained" by everyone who can see it: withVisibility announces channel.created.
  core.withVisibility(() => db.tx(() => {
    const max = db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM channels');
    db.run(
      'INSERT INTO channels (id, name, type, topic, position, private, user_limit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, p.type, cleanTopic(p.topic ?? ''), Number(max?.p ?? -1) + 1, p.private ? 1 : 0, p.userLimit ?? 0, core.now(),
    );
    for (const roleId of allowed) db.run('INSERT INTO channel_allowed_roles (channel_id, role_id) VALUES (?, ?)', id, roleId);
  }));
  return { channel: core.repo.toChannel(core.repo.channel(id)!) };
};

const update: Handler = (core, ctx, payload) => {
  const p = channelUpdateSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_CHANNELS);
  const { channel } = core.access.visibleChannel(actor, p.id);
  const name = p.name === undefined ? channel.name : cleanChannelName(p.name, channel.type);
  if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty channel name');
  if (channel.type === 'text' && (p.userLimit ?? 0) !== 0) throw new ProtocolError('BAD_REQUEST', 'userLimit is for voice channels');
  const allowed = p.allowedRoleIds === undefined ? null : checkAllowedRoles(core, p.allowedRoleIds);
  const { db } = core;
  const { before, after } = core.withVisibility(() => db.tx(() => {
    db.run(
      'UPDATE channels SET name = ?, topic = ?, private = ?, user_limit = ? WHERE id = ?',
      name,
      p.topic === undefined ? channel.topic : cleanTopic(p.topic),
      p.private === undefined ? channel.private : p.private ? 1 : 0,
      p.userLimit ?? channel.user_limit,
      channel.id,
    );
    if (allowed) {
      db.run('DELETE FROM channel_allowed_roles WHERE channel_id = ?', channel.id);
      for (const roleId of allowed) db.run('INSERT INTO channel_allowed_roles (channel_id, role_id) VALUES (?, ?)', channel.id, roleId);
    }
  }));
  const wire = core.repo.toChannel(core.repo.channel(channel.id)!);
  for (const s of ctx.sessions.list()) {
    if (before.get(s.userId)?.has(channel.id) && after.get(s.userId)?.has(channel.id)) {
      ctx.sessions.send(s.sessionId, { t: 'channel.updated', d: { channel: wire } });
    }
  }
  if (p.private !== undefined || allowed) core.events.emit('access.changed', { userIds: null });
  return { channel: wire };
};

const remove: Handler = (core, ctx, payload) => {
  const p = channelDeleteSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_CHANNELS);
  const { channel } = core.access.visibleChannel(actor, p.id);
  const { db } = core;
  // Messages, reactions, mentions, read states, allowed roles and files go with it (ON DELETE CASCADE).
  core.withVisibility(() => db.tx(() => db.run('DELETE FROM channels WHERE id = ?', channel.id)));
  core.events.emit('channel.deleted', { channelId: channel.id, type: channel.type });
  return {};
};

/**
 * `ids` is the new order of every channel the actor can see. Hidden channels keep
 * their slots, so the actor learns nothing about them and cannot move them.
 */
const reorder: Handler = (core, ctx, payload) => {
  const p = channelReorderSchema.parse(payload);
  const actor = core.member(ctx.userId);
  core.access.requireServer(actor, PERMISSIONS.MANAGE_CHANNELS);
  if (new Set(p.ids).size !== p.ids.length) throw new ProtocolError('BAD_REQUEST', 'duplicate ids');
  const all = core.repo.channels();
  const visible = all.filter((ch) => core.access.channelPerms(actor, ch) !== 0);
  const wanted = new Set(p.ids);
  if (visible.length !== p.ids.length || visible.some((ch) => !wanted.has(ch.id))) {
    throw new ProtocolError('BAD_REQUEST', 'ids must list exactly the visible channels');
  }
  let next = 0;
  const order = all.map((ch) => (core.access.channelPerms(actor, ch) !== 0 ? p.ids[next++]! : ch.id));
  const changed: string[] = [];
  core.db.tx(() => {
    order.forEach((id, position) => {
      const before = all.find((ch) => ch.id === id)!;
      if (Number(before.position) === position) return;
      core.db.run('UPDATE channels SET position = ? WHERE id = ?', position, id);
      changed.push(id);
    });
  });
  for (const id of changed) {
    const row = core.repo.channel(id)!;
    core.broadcastChannel(row, { t: 'channel.updated', d: { channel: core.repo.toChannel(row) } });
  }
  return {};
};

const read: Handler = (core, ctx, payload) => {
  const p = channelReadSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { channel } = core.access.visibleChannel(actor, p.channelId);
  if (channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'voice channels have no messages');
  const newest = Number(core.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?', channel.id)?.id ?? 0);
  const upTo = Math.min(p.messageId, newest);
  core.db.run(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)`,
    ctx.userId, channel.id, upTo,
  );
  return { readState: core.repo.readStates(ctx.userId, [channel.id])[0] };
};

export const channelHandlers: Record<string, Handler> = {
  'channel.create': create,
  'channel.update': update,
  'channel.delete': remove,
  'channel.reorder': reorder,
  'channel.read': read,
};

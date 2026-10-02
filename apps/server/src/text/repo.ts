import { randomBytes } from 'node:crypto';
import {
  CHAT_LIMITS,
  toBase32,
  type Attachment,
  type AttachmentKind,
  type Channel,
  type Member,
  type Message,
  type MessageMentions,
  type Reaction,
  type ReadState,
  type Role,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';

/** Channel, role and file ids: 128 random bits in base32 (spec §5.3). */
export function newEntityId(): string {
  return toBase32(randomBytes(16)).slice(0, 26);
}

export interface RoleRow {
  id: string;
  name: string;
  color: number;
  permissions: number;
  position: number;
  hoist: number;
  mentionable: number;
  is_default: number;
  system_tag: string | null;
}

export interface ChannelRow {
  id: string;
  name: string;
  type: 'text' | 'voice';
  topic: string;
  position: number;
  private: number;
  user_limit: number;
  created_at: number;
}

export interface MessageRow {
  id: number;
  channel_id: string;
  user_id: string;
  content: string;
  reply_to_id: number | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  client_msg_id: string | null;
  mention_users: string;
  mention_roles: string;
  mention_everyone: number;
}

export interface UserRow {
  id: string;
  nickname: string;
  joined_at: number;
  removed_at: number | null;
  last_ip: string | null;
  public_key: Uint8Array;
}

function jsonIds(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toRole(r: RoleRow): Role {
  return {
    id: r.id,
    name: r.name,
    color: Number(r.color),
    permissions: Number(r.permissions),
    position: Number(r.position),
    hoist: r.hoist === 1,
    mentionable: r.mentionable === 1,
    isDefault: r.is_default === 1,
  };
}

/**
 * Typed queries of the text module. Every method is synchronous (node:sqlite),
 * so a sequence of them inside `db.tx` is atomic (spec §3.5, §5.1).
 */
export class TextRepo {
  constructor(readonly db: Db) {}

  // ---- roles ----

  roles(): RoleRow[] {
    return this.db.all<RoleRow>('SELECT * FROM roles ORDER BY position DESC, id');
  }

  role(id: string): RoleRow | undefined {
    return this.db.get<RoleRow>('SELECT * FROM roles WHERE id = ?', id);
  }

  everyoneRole(): RoleRow | undefined {
    return this.db.get<RoleRow>('SELECT * FROM roles WHERE is_default = 1');
  }

  /** The user's roles, `@everyone` excluded. */
  userRoles(userId: string): RoleRow[] {
    return this.db.all<RoleRow>(
      'SELECT r.* FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ? AND r.is_default = 0',
      userId,
    );
  }

  roleMembers(roleId: string): string[] {
    return this.db
      .all<{ user_id: string }>(
        'SELECT ur.user_id FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = ? AND u.removed_at IS NULL',
        roleId,
      )
      .map((r) => r.user_id);
  }

  // ---- channels ----

  channels(): ChannelRow[] {
    return this.db.all<ChannelRow>('SELECT * FROM channels ORDER BY position, created_at, id');
  }

  channel(id: string): ChannelRow | undefined {
    return this.db.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
  }

  allowedRoles(channelId: string): string[] {
    return this.db
      .all<{ role_id: string }>('SELECT role_id FROM channel_allowed_roles WHERE channel_id = ? ORDER BY role_id', channelId)
      .map((r) => r.role_id);
  }

  lastMessageId(channelId: string): number {
    const row = this.db.get<{ id: number | null }>(
      'SELECT MAX(id) AS id FROM messages WHERE channel_id = ? AND deleted_at IS NULL',
      channelId,
    );
    return Number(row?.id ?? 0);
  }

  toChannel(r: ChannelRow): Channel {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      topic: r.topic,
      position: Number(r.position),
      private: r.private === 1,
      allowedRoleIds: this.allowedRoles(r.id),
      userLimit: Number(r.user_limit),
      lastMessageId: this.lastMessageId(r.id),
    };
  }

  // ---- members ----

  user(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT id, nickname, joined_at, removed_at, last_ip, public_key FROM users WHERE id = ?', id);
  }

  isMember(userId: string): boolean {
    return this.db.get('SELECT 1 AS x FROM users WHERE id = ? AND removed_at IS NULL', userId) !== undefined;
  }

  memberIds(): string[] {
    return this.db.all<{ id: string }>('SELECT id FROM users WHERE removed_at IS NULL').map((r) => r.id);
  }

  roleIdsOf(userId: string): string[] {
    return this.userRoles(userId)
      .sort((a, b) => Number(b.position) - Number(a.position))
      .map((r) => r.id);
  }

  member(userId: string, online: boolean): Member | null {
    const u = this.db.get<{ id: string; nickname: string; joined_at: number; avatar_file_id: string | null }>(
      'SELECT id, nickname, joined_at, avatar_file_id FROM users WHERE id = ? AND removed_at IS NULL',
      userId,
    );
    if (!u) return null;
    return { userId: u.id, nickname: u.nickname, roleIds: this.roleIdsOf(u.id), online, joinedAt: Number(u.joined_at), avatar: u.avatar_file_id ?? null };
  }

  members(isOnline: (userId: string) => boolean): Member[] {
    const users = this.db.all<{ id: string; nickname: string; joined_at: number; avatar_file_id: string | null }>(
      'SELECT id, nickname, joined_at, avatar_file_id FROM users WHERE removed_at IS NULL ORDER BY nickname_norm',
    );
    const roleRows = this.db.all<{ user_id: string; role_id: string }>(
      `SELECT ur.user_id, ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE r.is_default = 0 ORDER BY r.position DESC`,
    );
    const byUser = new Map<string, string[]>();
    for (const r of roleRows) {
      const list = byUser.get(r.user_id) ?? [];
      list.push(r.role_id);
      byUser.set(r.user_id, list);
    }
    return users.map((u) => ({
      userId: u.id,
      nickname: u.nickname,
      roleIds: byUser.get(u.id) ?? [],
      online: isOnline(u.id),
      joinedAt: Number(u.joined_at),
      avatar: u.avatar_file_id ?? null,
    }));
  }

  // ---- messages ----

  message(id: number): MessageRow | undefined {
    return this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  }

  reactionsOf(ids: readonly number[]): Map<number, Reaction[]> {
    const out = new Map<number, Reaction[]>();
    if (ids.length === 0) return out;
    const rows = this.db.all<{ message_id: number; emoji: string; user_id: string }>(
      `SELECT message_id, emoji, user_id FROM reactions
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
      JSON.stringify(ids),
    );
    for (const r of rows) {
      const id = Number(r.message_id);
      const list = out.get(id) ?? [];
      let entry = list.find((x) => x.emoji === r.emoji);
      if (!entry) {
        entry = { emoji: r.emoji, userIds: [] };
        list.push(entry);
      }
      entry.userIds.push(r.user_id);
      out.set(id, list);
    }
    return out;
  }

  reactions(id: number): Reaction[] {
    return this.reactionsOf([id]).get(id) ?? [];
  }

  /** The files of these messages, each list in the order they were sent (spec 2026-10-01-anexos §2). */
  attachmentsOf(ids: readonly number[]): Map<number, Attachment[]> {
    const out = new Map<number, Attachment[]>();
    if (ids.length === 0) return out;
    const rows = this.db.all<{
      id: string;
      message_id: number;
      name: string;
      size: number;
      kind: AttachmentKind;
      mime: string;
      width: number | null;
      height: number | null;
    }>(
      `SELECT id, message_id, name, size, kind, mime, width, height FROM files
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id, position`,
      JSON.stringify(ids),
    );
    for (const r of rows) {
      const id = Number(r.message_id);
      const list = out.get(id) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        size: Number(r.size),
        kind: r.kind,
        mime: r.mime,
        ...(r.width === null || r.height === null ? {} : { width: Number(r.width), height: Number(r.height) }),
      });
      out.set(id, list);
    }
    return out;
  }

  /** True when the message has at least one file (its text may then be empty). */
  hasAttachments(messageId: number): boolean {
    return this.db.get('SELECT 1 AS x FROM files WHERE message_id = ? LIMIT 1', messageId) !== undefined;
  }

  toMessages(rows: readonly MessageRow[]): Message[] {
    const ids = rows.map((r) => Number(r.id));
    const reactions = this.reactionsOf(ids);
    const attachments = this.attachmentsOf(ids);
    return rows.map((r) => this.#toMessage(r, reactions.get(Number(r.id)) ?? [], attachments.get(Number(r.id)) ?? []));
  }

  toMessage(row: MessageRow): Message {
    return this.toMessages([row])[0]!;
  }

  #toMessage(r: MessageRow, reactions: Reaction[], attachments: Attachment[]): Message {
    let replyTo: Message['replyTo'] = null;
    if (r.reply_to_id !== null) {
      const target = this.message(Number(r.reply_to_id));
      // Only same-channel replies exist (checked on send); anything else reads as deleted (spec §5.3).
      if (!target || target.channel_id !== r.channel_id || target.deleted_at !== null) {
        replyTo = { id: Number(r.reply_to_id), authorId: null, content: '', deleted: true };
      } else {
        replyTo = {
          id: Number(target.id),
          authorId: target.user_id,
          content: target.content.slice(0, CHAT_LIMITS.replyPreviewLength),
          deleted: false,
        };
      }
    }
    const mentions: MessageMentions = {
      users: jsonIds(r.mention_users),
      roles: jsonIds(r.mention_roles),
      everyone: r.mention_everyone === 1,
    };
    return {
      id: Number(r.id),
      channelId: r.channel_id,
      authorId: r.user_id,
      content: r.content,
      createdAt: Number(r.created_at),
      editedAt: r.edited_at === null ? null : Number(r.edited_at),
      replyTo,
      reactions,
      mentions,
      clientMsgId: r.client_msg_id,
      attachments,
    };
  }

  // ---- read states ----

  readStates(userId: string, channelIds: readonly string[]): ReadState[] {
    if (channelIds.length === 0) return [];
    const reads = new Map(
      this.db
        .all<{ channel_id: string; last_read_message_id: number }>(
          'SELECT channel_id, last_read_message_id FROM read_states WHERE user_id = ?',
          userId,
        )
        .map((r) => [r.channel_id, Number(r.last_read_message_id)]),
    );
    const counts = new Map(
      this.db
        .all<{ channel_id: string; n: number }>(
          `SELECT m.channel_id, COUNT(*) AS n FROM mentions mn
           JOIN messages m ON m.id = mn.message_id
           LEFT JOIN read_states rs ON rs.user_id = mn.user_id AND rs.channel_id = m.channel_id
           WHERE mn.user_id = ? AND m.deleted_at IS NULL AND m.id > COALESCE(rs.last_read_message_id, 0)
           GROUP BY m.channel_id`,
          userId,
        )
        .map((r) => [r.channel_id, Number(r.n)]),
    );
    return channelIds.map((channelId) => ({
      channelId,
      lastReadMessageId: reads.get(channelId) ?? 0,
      mentionCount: counts.get(channelId) ?? 0,
    }));
  }
}

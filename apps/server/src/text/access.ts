import {
  PERMISSIONS,
  ProtocolError,
  has,
  permissionsFor,
  topPosition,
  type ChannelAccess,
  type PermissionSubject,
} from '@ghostlink/shared';
import type { ChannelRow, TextRepo } from './repo.js';

/** A member (or former member) as permissionsFor() and canActOn() see them (roles carry positions). */
export interface Subject extends PermissionSubject {
  userId: string;
  isMember: boolean;
}


/**
 * Permission decisions of the text module, always through the shared
 * permissionsFor() (spec §6) and always read fresh from the database, so a
 * change is effective for the very next request or broadcast.
 */
export class Access {
  constructor(private readonly repo: TextRepo) {}

  ownerId(): string | null {
    return this.repo.db.get<{ owner_user_id: string | null }>('SELECT owner_user_id FROM server_meta WHERE id = 1')?.owner_user_id ?? null;
  }

  isOwner(userId: string): boolean {
    return this.ownerId() === userId;
  }

  subject(userId: string): Subject {
    const isMember = this.repo.isMember(userId);
    const everyone = Number(this.repo.everyoneRole()?.permissions ?? 0);
    const roles = isMember
      ? this.repo.userRoles(userId).map((r) => ({ id: r.id, permissions: Number(r.permissions), position: Number(r.position) }))
      : [];
    return { userId, isMember, isOwner: isMember && this.isOwner(userId), everyone, roles };
  }

  channelAccess(channel: ChannelRow): ChannelAccess {
    return { private: channel.private === 1, allowedRoleIds: channel.private === 1 ? this.repo.allowedRoles(channel.id) : [] };
  }

  /** Server-wide bits; 0 for someone who is not a member. */
  serverPerms(subject: Subject): number {
    return subject.isMember ? permissionsFor(subject) : 0;
  }

  /** Bits inside a channel; 0 for a non-member or a channel they cannot see (spec §5.3). */
  channelPerms(subject: Subject, channel: ChannelRow, access: ChannelAccess = this.channelAccess(channel)): number {
    if (!subject.isMember) return 0;
    const bits = permissionsFor(subject, access);
    return has(bits, PERMISSIONS.VIEW_CHANNEL) ? bits : 0;
  }

  canView(userId: string, channel: ChannelRow, access?: ChannelAccess): boolean {
    return has(this.channelPerms(this.subject(userId), channel, access), PERMISSIONS.VIEW_CHANNEL);
  }

  visibleChannelIds(userId: string): Set<string> {
    const subject = this.subject(userId);
    const out = new Set<string>();
    if (!subject.isMember) return out;
    for (const ch of this.repo.channels()) if (this.channelPerms(subject, ch) !== 0) out.add(ch.id);
    return out;
  }

  /**
   * The channel as the actor may see it: NOT_FOUND when it does not exist or is
   * hidden from them — the same answer in both cases (spec §5.3).
   */
  visibleChannel(subject: Subject, channelId: string): { channel: ChannelRow; bits: number } {
    const channel = this.repo.channel(channelId);
    if (!channel) throw new ProtocolError('NOT_FOUND');
    const bits = this.channelPerms(subject, channel);
    if (!has(bits, PERMISSIONS.VIEW_CHANNEL)) throw new ProtocolError('NOT_FOUND');
    return { channel, bits };
  }

  /** Throws FORBIDDEN unless the server-wide bits include `flag`. */
  requireServer(subject: Subject, flag: number): number {
    const bits = this.serverPerms(subject);
    if (!has(bits, flag)) throw new ProtocolError('FORBIDDEN');
    return bits;
  }

  /** Highest role position; the owner is above everyone (spec §6). */
  topPosition(userId: string): number {
    const subject = this.subject(userId);
    if (subject.isOwner) return Number.MAX_SAFE_INTEGER;
    return topPosition(subject.roles);
  }
}

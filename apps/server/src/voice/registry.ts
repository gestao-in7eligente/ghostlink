import type { VoiceChannelState, VoiceParticipant } from '@ghostlink/shared';
import type { TrackKind } from '../livekit/backend.js';

interface Present {
  /** LiveKit participant sid: a late participant_left of an older connection must not remove a newer one. */
  sid: string;
  tracks: Map<string, TrackKind>;
}

/**
 * The in-memory voice state (spec §7): who the server assigned to which room, who
 * LiveKit says is actually in each room (with their tracks), and the display flags.
 * Pure bookkeeping — no I/O, no permissions. Mutators return the channel ids whose
 * `voice.state` changed, so the caller broadcasts exactly those.
 */
export class VoiceRegistry {
  readonly #assigned = new Map<string, string>();
  readonly #rooms = new Map<string, Map<string, Present>>();
  readonly #self = new Map<string, { muted: boolean; deafened: boolean }>();
  readonly #serverMuted = new Set<string>();
  readonly #serverDeafened = new Set<string>();

  // ---- assignment (what the /rtc proxy allows) ----

  assignedChannel(userId: string): string | null {
    return this.#assigned.get(userId) ?? null;
  }

  assign(userId: string, channelId: string): void {
    this.#assigned.set(userId, channelId);
  }

  unassign(userId: string): void {
    this.#assigned.delete(userId);
  }

  /** How many users are assigned to the channel, not counting `except` (user_limit check). */
  assignedCount(channelId: string, except?: string): number {
    let n = 0;
    for (const [userId, ch] of this.#assigned) if (ch === channelId && userId !== except) n++;
    return n;
  }

  assignments(): [userId: string, channelId: string][] {
    return [...this.#assigned];
  }

  // ---- display flags ----

  setSelfState(userId: string, state: { muted: boolean; deafened: boolean }): string[] {
    this.#self.set(userId, { ...state });
    return this.#channelsOf(userId);
  }

  isServerMuted(userId: string): boolean {
    return this.#serverMuted.has(userId);
  }

  setServerMuted(userId: string, muted: boolean): string[] {
    if (muted === this.#serverMuted.has(userId)) return [];
    if (muted) this.#serverMuted.add(userId);
    else this.#serverMuted.delete(userId);
    return this.#channelsOf(userId);
  }

  isServerDeafened(userId: string): boolean {
    return this.#serverDeafened.has(userId);
  }

  setServerDeafened(userId: string, deafened: boolean): string[] {
    if (deafened === this.#serverDeafened.has(userId)) return [];
    if (deafened) this.#serverDeafened.add(userId);
    else this.#serverDeafened.delete(userId);
    return this.#channelsOf(userId);
  }

  /** The user went offline for good: drop everything but a server mute or deafen (they outlive a reconnect). */
  forget(userId: string): string[] {
    this.#assigned.delete(userId);
    this.#self.delete(userId);
    return this.removeEverywhere(userId);
  }

  // ---- presence reported by LiveKit ----

  /** Who LiveKit says is in the channel's room. */
  presentIn(channelId: string): string[] {
    return [...(this.#rooms.get(channelId)?.keys() ?? [])];
  }

  /** Channel ids with at least one participant. */
  channels(): string[] {
    return [...this.#rooms.keys()];
  }

  /** The channel where LiveKit sees the user, if any. */
  channelOf(userId: string): string | null {
    return this.#channelsOf(userId)[0] ?? null;
  }

  /** The LiveKit participant sid of the user's connection in `channelId`, or null when LiveKit does not see them there. */
  sidIn(channelId: string, userId: string): string | null {
    return this.#rooms.get(channelId)?.get(userId)?.sid ?? null;
  }

  /** participant_joined (or a track event for someone we had not seen): the user is in `channelId` only. */
  join(channelId: string, userId: string, sid: string): string[] {
    const changed = this.removeEverywhere(userId, channelId);
    const room = this.#rooms.get(channelId) ?? new Map<string, Present>();
    this.#rooms.set(channelId, room);
    const current = room.get(userId);
    if (current?.sid === sid) return changed;
    room.set(userId, { sid, tracks: new Map() });
    return [...new Set([...changed, channelId])];
  }

  /** participant_left: ignored when `sid` is an older connection than the one we track. */
  leave(channelId: string, userId: string, sid: string | null): string[] {
    const room = this.#rooms.get(channelId);
    const current = room?.get(userId);
    if (!room || !current || (sid !== null && current.sid !== sid)) return [];
    room.delete(userId);
    if (room.size === 0) this.#rooms.delete(channelId);
    return [channelId];
  }

  /** Removes the user from every room except `keep`. */
  removeEverywhere(userId: string, keep?: string): string[] {
    const changed: string[] = [];
    for (const [channelId, room] of this.#rooms) {
      if (channelId === keep || !room.delete(userId)) continue;
      if (room.size === 0) this.#rooms.delete(channelId);
      changed.push(channelId);
    }
    return changed;
  }

  clearChannel(channelId: string): string[] {
    return this.#rooms.delete(channelId) ? [channelId] : [];
  }

  trackPublished(channelId: string, userId: string, sid: string, track: { sid: string; source: TrackKind }): string[] {
    const changed = this.#rooms.get(channelId)?.get(userId) ? [] : this.join(channelId, userId, sid);
    const present = this.#rooms.get(channelId)!.get(userId)!;
    const before = this.#flags(present);
    present.tracks.set(track.sid, track.source);
    return this.#flags(present) === before ? changed : [...new Set([...changed, channelId])];
  }

  trackUnpublished(channelId: string, userId: string, trackSid: string): string[] {
    const present = this.#rooms.get(channelId)?.get(userId);
    if (!present) return [];
    const before = this.#flags(present);
    present.tracks.delete(trackSid);
    return this.#flags(present) === before ? [] : [channelId];
  }

  /** Whether LiveKit reports a microphone track for the user (tests and diagnostics). */
  hasMicrophone(userId: string): boolean {
    const channelId = this.channelOf(userId);
    const present = channelId ? this.#rooms.get(channelId)?.get(userId) : undefined;
    return present ? [...present.tracks.values()].includes('microphone') : false;
  }

  /**
   * Reconciliation (spec §7): replaces the presence map with LiveKit's view.
   * `rooms`: channelId → userId → { sid, tracks }. Returns the channels that changed.
   */
  replacePresence(rooms: Map<string, Map<string, { sid: string; tracks: { sid: string; source: TrackKind }[] }>>): string[] {
    const before = new Map([...this.#rooms].map(([ch]) => [ch, this.#fingerprint(ch)]));
    this.#rooms.clear();
    for (const [channelId, users] of rooms) {
      if (users.size === 0) continue;
      const room = new Map<string, Present>();
      for (const [userId, p] of users) room.set(userId, { sid: p.sid, tracks: new Map(p.tracks.map((t) => [t.sid, t.source])) });
      this.#rooms.set(channelId, room);
    }
    const changed = new Set<string>();
    for (const channelId of new Set([...before.keys(), ...this.#rooms.keys()])) {
      if (before.get(channelId) !== this.#fingerprint(channelId)) changed.add(channelId);
    }
    return [...changed];
  }

  // ---- snapshots ----

  state(channelId: string): VoiceChannelState {
    const room = this.#rooms.get(channelId);
    const participants: VoiceParticipant[] = [];
    for (const [userId, present] of room ?? []) {
      const self = this.#self.get(userId) ?? { muted: false, deafened: false };
      const kinds = new Set(present.tracks.values());
      participants.push({
        userId,
        muted: self.muted,
        deafened: self.deafened,
        camera: kinds.has('camera'),
        screen: kinds.has('screen_share'),
        serverMuted: this.#serverMuted.has(userId),
        serverDeafened: this.#serverDeafened.has(userId),
      });
    }
    participants.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return { channelId, participants };
  }

  #channelsOf(userId: string): string[] {
    return [...this.#rooms].filter(([, room]) => room.has(userId)).map(([ch]) => ch);
  }

  #flags(p: Present): string {
    const kinds = new Set(p.tracks.values());
    return `${kinds.has('camera')}${kinds.has('screen_share')}`;
  }

  #fingerprint(channelId: string): string {
    const room = this.#rooms.get(channelId);
    if (!room) return '';
    return [...room].map(([u, p]) => `${u}:${p.sid}:${this.#flags(p)}`).sort().join('|');
  }
}

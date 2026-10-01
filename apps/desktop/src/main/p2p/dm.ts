// Direct messages between two friends (friends spec §4, §5.3, §8; phase 2): open, send, edit,
// delete, reply, the read mark, unread counts, "delivered", typing and hidden conversations.
// Every change is a signed entry in this person's log (entries.ts), stored with the message it
// makes in one transaction (store.ts) and sent to the friend when their link is up (sync.ts).
//
// Sending never needs the friend online: the entry waits here and goes out on the next link.
// A conversation outlives the friendship: once the friend is removed or blocked it stops
// syncing and stays readable, and writing in it is refused.
//
// Message text never reaches the log: only the notification and the renderer see it.
//
// Files (attachments spec §3, phase 3): attach() keeps the picked bytes aside, send() puts what
// they are into the signed msg entry and keeps them in friends/files; the friend's computer asks
// for them over the link (blobs.ts). Images up to 5 MB come by themselves when the message
// arrives or the link comes up; anything else when the person asks (fetchFile). Deleting a
// message removes its files from the disk once no other message carries them.
import { readFileSync } from 'node:fs';
import { cleanFileName, cleanMessageContent } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import {
  DM_ATTACHMENTS_MAX,
  DM_AUTO_FETCH_MAX_BYTES,
  DM_FILE_MAX_BYTES,
  DM_TEXT_MAX,
  type DmAttachment,
  type DmConversation,
  type DmEvent,
  type DmFileInfo,
  type DmFileRef,
  type DmFileState,
  type DmMessage,
} from '../../shared/dmTypes.js';
import { Blobs } from './blobs.js';
import { dmConversationId, dmMembers } from './conversations.js';
import { FILE_HASH, describeFile, type DmFiles } from './dmFiles.js';
import { ENTRY_MAX_BYTES, checkEntry, entryAuthor, entryBodyJson, entrySize, newMessageId, parseEntryBody, signEntry, type Entry, type EntryBody, type EntryVerdict } from './entries.js';
import type { ConversationMessage } from './frames.js';
import { shortCode } from './friendCode.js';
import { keyToText, sameKey, type FriendKey } from './friendKey.js';
import type { FriendTraffic, PeerLink } from './friends.js';
import type { Timers } from './inbox.js';
import type { ConversationRow, FriendsStore, MessageRow } from './store.js';
import { ConversationSync, storedEntry } from './sync.js';

/** spec §3.3: one typing signal every 3 s at most, per conversation. */
export const TYPING_INTERVAL_MS = 3_000;
/** A burst of messages in one conversation makes one notification, with the newest. */
export const NOTIFY_DELAY_MS = 500;
/** The most messages one history call returns (dmIpc.ts holds the renderer to it too). */
export const HISTORY_LIMIT_MAX = 200;

/** A desktop notification for a message from a friend; a click opens `conv`. */
export interface DmNotification {
  conv: string;
  /** The friend's name as shown here (local nickname, else their own). */
  title: string;
  body: string;
}

export interface DmDeps {
  store: Pick<FriendsStore, 'get' | 'dm'>;
  /** This person's friend key: it signs every entry. */
  key: FriendKey;
  /** IPC_EVENTS.dm. */
  emit(event: DmEvent): void;
  /** A message from a friend arrived (main shows it only while the window is not focused). */
  notify?(notification: DmNotification): void;
  now?: () => number;
  timers?: Timers;
  /** <userData>/friends/files; without it no file can be sent or received. */
  files?: DmFiles;
}

/** A picked file waiting for its message: what it is, without a name (the message gives one). */
type StagedFile = Omit<DmFileInfo, 'name'>;

interface PendingNote {
  timer: unknown;
  peer: Uint8Array;
  id: string;
}

export class Dm implements FriendTraffic {
  readonly #d: DmDeps;
  readonly #me: Uint8Array;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #sync: ConversationSync;
  /** When the last typing signal went out, per conversation. */
  readonly #typingSent = new Map<string, number>();
  readonly #notes = new Map<string, PendingNote>();
  readonly #files: DmFiles | null;
  readonly #blobs: Blobs | null;
  /** Picked files not sent yet, by hash. */
  readonly #staged = new Map<string, StagedFile>();
  /** Files whose last transfer failed: they do not come by themselves again until asked for. */
  readonly #failed = new Set<string>();

  constructor(deps: DmDeps) {
    this.#d = deps;
    this.#me = deps.key.publicKey;
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.#sync = new ConversationSync({
      me: this.#me,
      store: deps.store.dm,
      accept: (peer, entry) => this.#accept(peer, entry),
      delivered: (conv, seq) => this.#delivered(conv, seq),
      timers: this.#timers,
    });
    this.#files = deps.files ?? null;
    this.#blobs = this.#files && new Blobs({
      files: this.#files,
      mayServe: (peer, hash) => this.#mayServe(peer, hash),
      changed: (hash, state, received) => this.#fileChanged(hash, state, received),
      timers: this.#timers,
      now: this.#now,
    });
  }

  get #store() {
    return this.#d.store.dm;
  }

  // window.ghostlink.dm.

  /** Every conversation, hidden ones included, the most recent first. */
  conversations(): DmConversation[] {
    const recent = (c: ConversationRow, s: DmConversation) => s.lastTs ?? c.createdAt;
    return this.#store
      .conversations()
      .map((c) => ({ c, s: this.#summary(c) }))
      .sort((x, y) => recent(y.c, y.s) - recent(x.c, x.s))
      .map((x) => x.s);
  }

  /** The conversation with that friend, created or shown again. FORBIDDEN unless they are a friend. */
  open(friend: Uint8Array): DmConversation {
    if (this.#d.store.get(friend)?.state !== 'friend') throw new AppError('FORBIDDEN');
    const id = dmConversationId(this.#me, friend);
    const created = this.#store.createConversation({ id, kind: 'dm', createdAt: this.#now(), hidden: false, members: dmMembers(this.#me, friend) });
    const shown = !created && this.#store.setHidden(id, false);
    const summary = this.#summary(this.#conversation(id));
    if (created || shown) this.#d.emit({ type: 'conversation', conversation: summary });
    return summary;
  }

  hide(conv: string): void {
    this.#conversation(conv);
    if (this.#store.setHidden(conv, true)) this.#emitConversation(conv);
  }

  history(conv: string, before: number | null, limit: number): DmMessage[] {
    const c = this.#conversation(conv);
    const rows = this.#store.history(conv, before, Math.max(1, Math.min(Math.floor(limit), HISTORY_LIMIT_MAX)));
    return rows.map((row) => this.#message(row, c));
  }

  /** The text may be blank when files go with it; each file must have gone through attach(). */
  send(conv: string, text: string, replyTo: string | null, files: readonly DmFileRef[] = []): DmMessage {
    this.#conversation(conv);
    const peer = this.#writablePeer(conv);
    if (files.length > DM_ATTACHMENTS_MAX) throw new AppError('BAD_REQUEST');
    const clean = files.length > 0 && cleanMessageContent(text) === '' ? '' : this.#text(text);
    if (replyTo !== null && !this.#store.message(conv, replyTo)) throw new AppError('NOT_FOUND');
    const attachments = files.map((ref) => ({ ...this.#stagedFile(ref.hash), name: cleanFileName(ref.name) }));
    // The bytes are in place before the entry that names them exists.
    for (const f of attachments) if (!this.#files!.commit(f.hash)) throw new AppError('NOT_FOUND');
    const message = this.#write(conv, peer, { kind: 'msg', id: newMessageId(), text: clean, replyTo, attachments });
    for (const f of attachments) this.#staged.delete(f.hash);
    return message;
  }

  /**
   * attachments spec §3: keeps picked bytes aside for the next message (FILE_TOO_LARGE above
   * 25 MB) and says what the message will carry. The type comes from the bytes, never the name.
   */
  attach(conv: string, name: string, bytes: Uint8Array): DmFileInfo {
    this.#conversation(conv);
    this.#writablePeer(conv);
    if (!this.#files) throw new AppError('P2P_UNAVAILABLE');
    if (bytes.byteLength === 0) throw new AppError('BAD_REQUEST');
    if (bytes.byteLength > DM_FILE_MAX_BYTES) throw new AppError('FILE_TOO_LARGE');
    const info = describeFile(name, bytes);
    this.#files.stage(info.hash, bytes);
    const { name: _name, ...staged } = info;
    this.#staged.set(info.hash, staged);
    return info;
  }

  /** "Baixar" on a file not here yet, or "Tentar de novo": asks the friend now (or as soon as they are online). */
  fetchFile(conv: string, hash: string): void {
    this.#conversation(conv);
    const file = this.#store.file(conv, hash);
    if (!file || !this.#blobs) throw new AppError('NOT_FOUND');
    if (this.#files!.has(hash) || this.#blobs.progress(hash)) return;
    this.#failed.delete(hash);
    this.#blobs.fetch(this.#peerOf(conv), hash, file.size);
    const progress = this.#blobs.progress(hash);
    if (progress?.state === 'absent') this.#d.emit({ type: 'file', hash, state: 'absent', received: 0 });
  }

  /** The name to offer in "Salvar como" for a file of this conversation that is here; NOT_FOUND otherwise. */
  savable(conv: string, hash: string): string {
    this.#conversation(conv);
    const file = this.#store.file(conv, hash);
    if (!file || !this.#files?.has(hash)) throw new AppError('NOT_FOUND');
    return file.name;
  }

  /** Copies a file of this conversation to where the person chose. */
  saveTo(conv: string, hash: string, destination: string): void {
    this.savable(conv, hash);
    this.#files!.copyTo(hash, destination);
  }

  /** app://ghostlink/_dmfile/<hash>: where a file that some message carries is, or null. */
  servable(hash: string): string | null {
    if (!this.#files || !FILE_HASH.test(hash) || !this.#files.has(hash) || this.#store.fileRefs(hash) === 0) return null;
    return this.#files.path(hash);
  }

  /** Only the author edits a message, and never one already deleted. */
  edit(conv: string, id: string, text: string): DmMessage {
    const c = this.#conversation(conv);
    const message = this.#store.message(conv, id);
    if (!message || message.deleted) throw new AppError('NOT_FOUND');
    if (!sameKey(message.author, this.#me)) throw new AppError('FORBIDDEN');
    const peer = this.#writablePeer(conv);
    const clean = this.#text(text);
    if (clean === message.text) return this.#message(message, c);
    return this.#write(conv, peer, { kind: 'edit', id, text: clean });
  }

  /** Only the author deletes a message; deleting it again changes nothing. */
  remove(conv: string, id: string): DmMessage {
    const c = this.#conversation(conv);
    const message = this.#store.message(conv, id);
    if (!message) throw new AppError('NOT_FOUND');
    if (!sameKey(message.author, this.#me)) throw new AppError('FORBIDDEN');
    if (message.deleted) return this.#message(message, c);
    const files = this.#store.attachments(conv, id);
    const deleted = this.#write(conv, this.#writablePeer(conv), { kind: 'delete', id });
    this.#release(files);
    return deleted;
  }

  /** Marks the friend's messages up to `ts` as read (never past the newest one they wrote). */
  read(conv: string, ts: number): void {
    this.#conversation(conv);
    if (this.#store.markRead(conv, this.#me, ts)) this.#emitConversation(conv);
  }

  /** "Digitando…": one signal every 3 s at most, and only while the friend's link is up. */
  typing(conv: string): void {
    this.#conversation(conv);
    const peer = this.#peerOf(conv);
    if (this.#d.store.get(peer)?.state !== 'friend') return;
    const now = this.#now();
    const last = this.#typingSent.get(conv);
    if (last !== undefined && now - last < TYPING_INTERVAL_MS) return;
    if (this.#sync.send(peer, { t: 'typing', conv })) this.#typingSent.set(conv, now);
  }

  /** The engine closes: nothing may run later. */
  dispose(): void {
    this.#sync.dispose();
    this.#blobs?.dispose();
    for (const note of this.#notes.values()) this.#timers.clearTimeout(note.timer);
    this.#notes.clear();
    this.#typingSent.clear();
  }

  // Friend links (FriendTraffic).

  up(peer: Uint8Array, link: PeerLink): void {
    this.#sync.up(peer, link);
    this.#blobs?.up(peer, link);
    // Images that did not come yet (the link dropped, the app closed) come now.
    const conv = dmConversationId(this.#me, peer);
    if (this.#store.conversation(conv)) this.#autoFetch(peer, this.#store.files(conv));
  }

  down(peer: Uint8Array, link: PeerLink): void {
    this.#sync.down(peer, link);
    this.#blobs?.down(peer, link);
  }

  receive(peer: Uint8Array, message: ConversationMessage, link: PeerLink): void {
    switch (message.t) {
      case 'typing':
        if (message.conv !== dmConversationId(this.#me, peer) || !this.#store.conversation(message.conv)) return;
        this.#d.emit({ type: 'typing', conv: message.conv, author: keyToText(peer) });
        return;
      case 'blob.want':
      case 'blob.part':
      case 'blob.missing':
        this.#blobs?.receive(peer, message, link);
        return;
      default:
        this.#sync.receive(peer, message, link);
    }
  }

  // Inside.

  #conversation(conv: string): ConversationRow {
    const c = this.#store.conversation(conv);
    if (!c) throw new AppError('NOT_FOUND');
    return c;
  }

  /** The other member of a 1:1 conversation. */
  #peerOf(conv: string): Uint8Array {
    const peer = this.#store.members(conv).find((key) => !sameKey(key, this.#me));
    if (!peer) throw new Error('a conversation without another member');
    return peer;
  }

  /** spec §5.3: writing needs the other person to still be a friend. */
  #writablePeer(conv: string): Uint8Array {
    const peer = this.#peerOf(conv);
    if (this.#d.store.get(peer)?.state !== 'friend') throw new AppError('FORBIDDEN');
    return peer;
  }

  /** Cleaned like a channel message; empty or longer than 4000 characters is refused. */
  #text(raw: string): string {
    const text = cleanMessageContent(raw);
    if (text === '' || text.length > DM_TEXT_MAX) throw new AppError('BAD_REQUEST');
    return text;
  }

  /** Signs our next entry, stores it with its effect, and sends it if the friend is online. */
  #write(conv: string, peer: Uint8Array, body: EntryBody): DmMessage {
    const entry = signEntry(this.#d.key, { conv, seq: this.#store.head(conv, this.#me) + 1, ts: this.#now(), kind: body.kind, body: entryBodyJson(body) });
    if (entrySize(entry) > ENTRY_MAX_BYTES) throw new AppError('BAD_REQUEST');
    const row = this.#store.append(storedEntry(entry, this.#me), body);
    if (!row) throw new Error(`our own ${body.kind} entry changed nothing`);
    if (body.kind === 'msg') this.#store.setHidden(conv, false);
    this.#sync.push(peer, entry);
    const message = this.#message(row, this.#conversation(conv));
    this.#d.emit({ type: 'message', message });
    this.#emitConversation(conv);
    return message;
  }

  /** An entry from that friend: checked, stored with its effect, and shown. */
  #accept(peer: Uint8Array, entry: Entry): EntryVerdict {
    const conv = dmConversationId(this.#me, peer);
    const members = dmMembers(this.#me, peer);
    const verdict = checkEntry(entry, { conv, members, head: (author) => this.#store.head(conv, author), now: this.#now() });
    if (verdict === 'bad-signature') throw new Error('an entry with a bad signature');
    if (verdict !== 'ok') return verdict;
    const author = entryAuthor(entry)!;
    const body = parseEntryBody(entry.kind, entry.body);
    const created = this.#store.createConversation({ id: conv, kind: 'dm', createdAt: this.#now(), hidden: false, members });
    // A deleted message's files may leave the disk once it is gone.
    const before = body?.kind === 'delete' ? this.#store.attachments(conv, body.id) : [];
    const row = this.#store.append(storedEntry(entry, author), body);
    if (row) {
      // A new message shows a closed conversation again.
      if (body?.kind === 'msg') {
        this.#store.setHidden(conv, false);
        if (!sameKey(author, this.#me)) this.#notify(peer, row);
        this.#autoFetch(peer, body.attachments);
      }
      this.#release(before);
      this.#d.emit({ type: 'message', message: this.#message(row, this.#conversation(conv)) });
    }
    if (created || row) this.#emitConversation(conv);
    return 'ok';
  }

  /** The friend's sync.have covers our entries up to `seq`: those messages are delivered. */
  #delivered(conv: string, seq: number): void {
    if (!this.#store.conversation(conv)) return;
    // They cannot have more of ours than we wrote.
    const upTo = Math.min(seq, this.#store.head(conv, this.#me));
    const before = this.#store.raiseDelivered(conv, upTo);
    if (before === null) return;
    const c = this.#conversation(conv);
    for (const row of this.#store.ownMessages(conv, this.#me, before, upTo)) this.#d.emit({ type: 'message', message: this.#message(row, c) });
  }

  #notify(peer: Uint8Array, row: MessageRow): void {
    if (!this.#d.notify) return;
    const pending = this.#notes.get(row.conv);
    if (pending) {
      pending.id = row.id;
      return;
    }
    const note: PendingNote = { timer: null, peer, id: row.id };
    note.timer = this.#timers.setTimeout(() => {
      this.#notes.delete(row.conv);
      // The newest message of the burst, as it is now: a message deleted meanwhile shows nothing.
      const message = this.#store.message(row.conv, note.id);
      if (!message || message.deleted) return;
      const friend = this.#d.store.get(note.peer);
      const title = friend?.localName ?? (friend?.nickname || shortCode(note.peer));
      // A message of files alone shows their names.
      const body = message.text || this.#store.attachments(row.conv, note.id).map((f) => `📎 ${f.name}`).join(', ');
      this.#d.notify?.({ conv: row.conv, title, body });
    }, NOTIFY_DELAY_MS);
    this.#notes.set(row.conv, note);
  }

  #emitConversation(conv: string): void {
    this.#d.emit({ type: 'conversation', conversation: this.#summary(this.#conversation(conv)) });
  }

  #summary(c: ConversationRow): DmConversation {
    const last = this.#store.last(c.id);
    return {
      id: c.id,
      kind: 'dm',
      peer: keyToText(this.#peerOf(c.id)),
      lastTs: last?.ts ?? null,
      lastText: last ? last.text : null,
      unread: this.#store.unread(c.id, this.#me),
      hidden: c.hidden,
    };
  }

  #message(row: MessageRow, c: ConversationRow): DmMessage {
    const mine = sameKey(row.author, this.#me);
    return {
      id: row.id,
      conv: row.conv,
      author: keyToText(row.author),
      mine,
      ts: row.ts,
      text: row.text,
      replyTo: row.replyTo,
      editedAt: row.editedAt,
      deleted: row.deleted,
      delivered: !mine || row.seq <= c.deliveredSeq,
      attachments: this.#store.attachments(row.conv, row.id).map((f) => this.#attachment(f)),
    };
  }

  // Files.

  #attachment(f: DmFileInfo): DmAttachment {
    if (this.#files?.has(f.hash)) return { ...f, state: 'ready', received: f.size };
    const progress = this.#blobs?.progress(f.hash);
    if (progress) return { ...f, ...progress };
    return { ...f, state: this.#failed.has(f.hash) ? 'failed' : 'absent', received: 0 };
  }

  /** A file picked with attach() (or one already kept here); NOT_FOUND for anything else. */
  #stagedFile(hash: string): StagedFile {
    const staged = this.#staged.get(hash);
    if (staged) return staged;
    if (!this.#files?.has(hash)) throw new AppError('NOT_FOUND');
    const { name: _name, ...kept } = describeFile('file', readFileSync(this.#files.path(hash)));
    return kept;
  }

  /** attachments spec §3: images up to 5 MB come by themselves; a file that failed waits for a click. */
  #autoFetch(peer: Uint8Array, files: readonly DmFileInfo[]): void {
    if (!this.#blobs || !this.#files) return;
    for (const f of files) {
      if (f.kind !== 'image' || f.size > DM_AUTO_FETCH_MAX_BYTES || this.#failed.has(f.hash) || this.#files.has(f.hash)) continue;
      this.#blobs.fetch(peer, f.hash, f.size);
    }
  }

  /** The friend may have a file from us: a message of the conversation we share with them carries it. */
  #mayServe(peer: Uint8Array, hash: string): boolean {
    const conv = dmConversationId(this.#me, peer);
    return this.#store.conversation(conv) !== undefined && this.#store.file(conv, hash) !== undefined;
  }

  #fileChanged(hash: string, state: DmFileState, received: number): void {
    if (state === 'failed') this.#failed.add(hash);
    else this.#failed.delete(hash);
    this.#d.emit({ type: 'file', hash, state, received });
  }

  /** Files of a deleted message: off the disk once no message carries them any more. */
  #release(files: readonly DmFileInfo[]): void {
    if (!this.#files) return;
    for (const hash of new Set(files.map((f) => f.hash))) {
      if (this.#store.fileRefs(hash) > 0 || this.#staged.has(hash)) continue;
      this.#blobs?.cancel(hash);
      this.#failed.delete(hash);
      this.#files.remove(hash);
      this.#d.emit({ type: 'file', hash, state: 'absent', received: 0 });
    }
  }
}

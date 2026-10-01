// Wires the pencil to the app (spec 2026-10-01-lapis-na-tela-design.md): screen.draw and
// screen.drawAllow from the server, my own strokes (shown at once, sent in batches), and, while I
// share a whole screen, the overlay over the real monitor. Started by the first mounted pencil
// component (the voice panel mounts one for the whole call), stopped by the last. It belongs to
// the call's server, also while the screen shows another one (chamada-continua §2).
import { useEffect } from 'react';
import { screenDrawAllowEventSchemaClient, screenDrawEventSchemaClient, type DrawPoint } from '@ghostlink/shared';
import { errorCodeOf } from '../../i18n/index.js';
import { useConnectionStore } from '../../stores/connection.js';
import { lifetime } from '../voice/lifetime.js';
import { useCallDirectory } from '../voice/runtime.js';
import { callServerId, useVoiceStore, type VoiceState } from '../voice/state.js';
import { StrokeBatcher, newStrokeId } from './batcher.js';
import { labelText, pencilColor } from './colors.js';
import { useDrawStore, type VoiceView } from './state.js';
import { StrokeStore, type StrokeInput } from './strokes.js';

// ---- the strokes on each shared screen ----

/** sharerId → the strokes on that person's screen (what the stream's canvas paints). */
const boards = new Map<string, StrokeStore>();
const boardListeners = new Map<string, Set<() => void>>();

export function boardOf(sharerId: string): StrokeStore {
  let board = boards.get(sharerId);
  if (!board) {
    board = new StrokeStore();
    boards.set(sharerId, board);
  }
  return board;
}

/** `listener` runs whenever strokes arrive on `sharerId`'s screen. */
export function subscribeBoard(sharerId: string, listener: () => void): () => void {
  const set = boardListeners.get(sharerId) ?? new Set();
  boardListeners.set(sharerId, set);
  set.add(listener);
  return () => void set.delete(listener);
}

function apply(sharerId: string, input: StrokeInput): void {
  boardOf(sharerId).apply(input);
  for (const listener of boardListeners.get(sharerId) ?? []) listener();
}

function clearBoards(): void {
  for (const [sharerId, board] of boards) {
    board.clear();
    for (const listener of boardListeners.get(sharerId) ?? []) listener();
  }
}

// ---- names for the labels ----

let nameOf: (userId: string) => string = (userId) => userId.slice(0, 8);

/** The author's name at the tip of their strokes. */
export function drawName(userId: string): string {
  return nameOf(userId);
}

// ---- the overlay over my shared monitor (spec §4) ----

/** Bumped when my share starts or ends: a late overlayOpen answer of an older share is ignored. */
let share = 0;
let overlayOpen = false;

function feedOverlay(input: StrokeInput): void {
  if (!overlayOpen) return;
  const stroke = { id: input.key, color: pencilColor(input.userId), label: labelText(nameOf(input.userId)), points: [...input.points], end: input.end };
  void window.ghostlink.draw.overlayStroke(stroke).catch(() => {});
}

/** My share went live (`fresh`), or the runtime starts while it already is: open the overlay. */
function shareStarted(v: VoiceState, fresh: boolean): void {
  const current = ++share;
  overlayOpen = false;
  // "Permitir desenhos" starts on for every new share (spec §3; the server does the same).
  if (fresh && v.call.channelId && v.selfUserId) {
    useDrawStore.getState().dispatch({ type: 'allow', channelId: v.call.channelId, sharerId: v.selfUserId, allow: true });
  }
  window.ghostlink.draw.overlayOpen().then(
    (open) => {
      if (current === share) overlayOpen = open;
      else if (open) void window.ghostlink.draw.overlayClose().catch(() => {});
    },
    () => {},
  );
}

function shareEnded(selfUserId: string | null): void {
  share++;
  overlayOpen = false;
  void window.ghostlink.draw.overlayClose().catch(() => {});
  if (selfUserId) boards.get(selfUserId)?.clear();
}

// ---- server events ----

function onDraw(d: unknown): void {
  const parsed = screenDrawEventSchemaClient.safeParse(d);
  if (!parsed.success) return;
  const { channelId, sharerId, userId, strokeId, points, end } = parsed.data;
  const v = useVoiceStore.getState();
  if (v.call.status === 'idle' || v.call.channelId !== channelId) return;
  const mine = sharerId === v.selfUserId;
  // Only on a screen I show: my own share, or one I watch.
  if (mine ? v.sharing === null : !v.watching.includes(sharerId)) return;
  const input: StrokeInput = { key: `${userId}:${strokeId}`, userId, points, end };
  apply(sharerId, input);
  if (mine) feedOverlay(input);
}

function onAllow(d: unknown): void {
  const parsed = screenDrawAllowEventSchemaClient.safeParse(d);
  if (parsed.success) useDrawStore.getState().dispatch({ type: 'allow', ...parsed.data });
}

function voiceView(v: VoiceState): VoiceView {
  return { selfUserId: v.selfUserId, call: v.call, channels: v.channels, watching: v.watching, sharing: v.sharing };
}

function start(): () => void {
  const draw = useDrawStore.getState().dispatch;
  const welcome = useConnectionStore.getState().welcome;
  if (callServerId(useVoiceStore.getState()) === null) draw({ type: 'welcome', welcome });
  const offConnection = useConnectionStore.subscribe((c, prev) => {
    // During a call the screen moving elsewhere (or back) changes nothing here.
    if (c.welcome === prev.welcome || callServerId(useVoiceStore.getState()) !== null) return;
    // A new welcome (a reconnect, another server) replaces the whole state (spec §13).
    draw({ type: 'welcome', welcome: c.welcome });
    clearBoards();
  });
  const offEvents = window.ghostlink.onServerEvent((event, serverId) => {
    const v = useVoiceStore.getState();
    // Only the voice runtime's server: the call's, during one.
    if (serverId !== v.serverId) return;
    if (event.t === 'welcome' && callServerId(v) !== null) {
      // The call's server reconnected (on screen or not).
      draw({ type: 'welcome', welcome: event.d });
      clearBoards();
    } else if (event.t === 'screen.draw') onDraw(event.d);
    else if (event.t === 'screen.drawAllow') onAllow(event.d);
  });
  const offVoice = useVoiceStore.subscribe((v, prev) => {
    // A call elsewhere ended: the pencil follows the screen again.
    if (v.serverId !== prev.serverId && callServerId(prev) !== null) {
      draw({ type: 'welcome', welcome: useConnectionStore.getState().welcome });
      clearBoards();
    }
    if ((v.sharing === null) !== (prev.sharing === null)) {
      if (v.sharing) shareStarted(v, true);
      else shareEnded(prev.selfUserId);
    }
    if (v.channels !== prev.channels || v.call !== prev.call || v.watching !== prev.watching || v.sharing !== prev.sharing) {
      draw({ type: 'voice', voice: voiceView(v) });
    }
    if (v.call.channelId !== prev.call.channelId && prev.call.channelId !== null) clearBoards();
  });
  const v = useVoiceStore.getState();
  if (v.sharing) shareStarted(v, false);
  draw({ type: 'voice', voice: voiceView(v) });
  return () => {
    offVoice();
    offEvents();
    offConnection();
    if (useVoiceStore.getState().sharing) shareEnded(useVoiceStore.getState().selfUserId);
    useDrawStore.getState().dispatch({ type: 'pencil', sharerId: null, voice: voiceView(useVoiceStore.getState()) });
    clearBoards();
  };
}

const runtime = lifetime(start);

/** Keeps the pencil's runtime alive while at least one pencil component is mounted, or a call is on. */
export function useDrawRuntime(): void {
  const directory = useCallDirectory();
  useEffect(() => {
    nameOf = (userId) => directory.displayName(userId);
  }, [directory]);
  useEffect(() => {
    runtime.retain();
    return () => runtime.release();
  }, []);
}

// ---- actions ----

/** Turns my pencil on for `sharerId`'s screen, or off (null). Refused when I may not draw there. */
export function setPencil(sharerId: string | null): void {
  useDrawStore.getState().dispatch({ type: 'pencil', sharerId, voice: voiceView(useVoiceStore.getState()) });
}

/** "Permitir desenhos" for my own share; back as it was when the server refuses. */
export async function setAllowDrawing(allow: boolean): Promise<void> {
  const v = useVoiceStore.getState();
  const channelId = v.call.channelId;
  const sharerId = v.selfUserId;
  if (!channelId || !sharerId || !v.sharing) return;
  const dispatch = useDrawStore.getState().dispatch;
  dispatch({ type: 'allow', channelId, sharerId, allow });
  try {
    await window.ghostlink.server.request('screen.drawAllow', { channelId, allow }, v.serverId ?? undefined);
  } catch {
    dispatch({ type: 'allow', channelId, sharerId, allow: !allow });
  }
}

/** My pencil on one screen: a stroke per drag, shown at once and sent in batches (spec §3). */
export interface Pen {
  down(point: DrawPoint): void;
  move(point: DrawPoint): void;
  up(): void;
}

export function createPen(sharerId: string): Pen | null {
  const v = useVoiceStore.getState();
  const channelId = v.call.channelId;
  const self = v.selfUserId;
  if (!channelId || !self) return null;
  // The call's server, also while another one is on screen.
  const server = v.serverId ?? undefined;
  let key = '';
  const batcher = new StrokeBatcher({
    send: (batch) => {
      const payload = { channelId, sharerId, strokeId: batch.strokeId, points: batch.points, end: batch.end };
      window.ghostlink.server.request('screen.draw', payload, server).catch((e: unknown) => {
        // Drawing was turned off, or the share ended: the pencil goes (a later event says why).
        const code = errorCodeOf(e);
        if ((code === 'FORBIDDEN' || code === 'NOT_FOUND') && useDrawStore.getState().pencil === sharerId) setPencil(null);
      });
      if (sharerId === self) feedOverlay({ key: `${self}:${batch.strokeId}`, userId: self, points: batch.points, end: batch.end });
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    newId: () => newStrokeId(),
  });
  // My own strokes show at once, without waiting for the server (spec §3).
  const local = (points: DrawPoint[], end: boolean) => apply(sharerId, { key, userId: self, points, end });
  return {
    down(point) {
      key = `${self}:${batcher.begin(point)}`;
      local([point], false);
    },
    move(point) {
      if (batcher.add(point)) local([point], false);
    },
    up() {
      if (batcher.strokeId === null) return;
      batcher.end();
      local([], true);
    },
  };
}

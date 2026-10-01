// The pencil's state (spec 2026-10-01-lapis-na-tela-design.md §1–§3): who may draw on which share,
// "Permitir desenhos" from the server, and the pencil going away with its share.
import { describe, expect, it } from 'vitest';
import type { VoiceParticipant } from '@ghostlink/shared';
import { canDraw, drawReducer, initialDrawState, ownShareAllowed, shareKey, type DrawState, type VoiceView } from '../../src/renderer/features/draw/state.js';

const ANA = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
const SHARING = { quality: '1080p30', content: 'motion', audio: false, name: 'Tela 1' } as unknown as VoiceView['sharing'];

const person = (userId: string, screen = false): VoiceParticipant => ({ userId, muted: false, deafened: false, camera: false, screen, serverMuted: false });

/** Bia's view: in VC1 with Ana, who shares; Bia watches her. */
function bia(over: Partial<VoiceView> = {}): VoiceView {
  return {
    selfUserId: BIA,
    call: { status: 'connected', channelId: 'VC1' },
    channels: { VC1: [person(ANA, true), person(BIA)] },
    watching: [ANA],
    sharing: null,
    ...over,
  };
}

/** Ana's view: she shares in VC1. */
function ana(over: Partial<VoiceView> = {}): VoiceView {
  return { ...bia(), selfUserId: ANA, watching: [], sharing: SHARING, ...over };
}

const on: DrawState = { ...initialDrawState, available: true };

describe('canDraw', () => {
  it('lets a viewer draw on a share they watch, and the sharer on their own', () => {
    expect(canDraw(on, bia(), ANA)).toBe(true);
    expect(canDraw(on, ana(), ANA)).toBe(true);
  });

  it('not on an old server, outside the call, or while it reconnects', () => {
    expect(canDraw(initialDrawState, bia(), ANA)).toBe(false);
    expect(canDraw(on, bia({ call: { status: 'idle', channelId: null } }), ANA)).toBe(false);
    expect(canDraw(on, bia({ call: { status: 'reconnecting', channelId: 'VC1' } }), ANA)).toBe(false);
  });

  it('not on a share I do not watch, one that ended, or my own when I do not share', () => {
    expect(canDraw(on, bia({ watching: [] }), ANA)).toBe(false);
    expect(canDraw(on, bia({ channels: { VC1: [person(ANA), person(BIA)] } }), ANA)).toBe(false);
    expect(canDraw(on, bia(), BIA)).toBe(false);
    expect(canDraw(on, ana({ sharing: null }), ANA)).toBe(false);
  });

  it('not when the sharer turned drawing off, for anyone, the sharer included', () => {
    const off = { ...on, off: [shareKey('VC1', ANA)] };
    expect(canDraw(off, bia(), ANA)).toBe(false);
    expect(canDraw(off, ana(), ANA)).toBe(false);
    expect(ownShareAllowed(off, ana())).toBe(false);
    expect(ownShareAllowed(on, ana())).toBe(true);
  });
});

describe('drawReducer', () => {
  it('reads the feature and the shares with drawing off from the welcome', () => {
    const welcome = { features: ['voice', 'screenDraw'], screenDraw: { disallowed: [{ channelId: 'VC1', sharerId: ANA }] } };
    expect(drawReducer(on, { type: 'welcome', welcome })).toEqual({ available: true, off: [shareKey('VC1', ANA)], pencil: null });
    // An old server: no pencil, whatever else the welcome says.
    expect(drawReducer(on, { type: 'welcome', welcome: { features: ['voice'], screenDraw: welcome.screenDraw } })).toEqual(initialDrawState);
    expect(drawReducer(on, { type: 'welcome', welcome: { features: ['screenDraw'], screenDraw: { disallowed: 'x' } } }).off).toEqual([]);
    expect(drawReducer(on, { type: 'welcome', welcome: null })).toEqual(initialDrawState);
  });

  it('turns the pencil on only where I may draw, and off', () => {
    const drawing = drawReducer(on, { type: 'pencil', sharerId: ANA, voice: bia() });
    expect(drawing.pencil).toBe(ANA);
    expect(drawReducer(drawing, { type: 'pencil', sharerId: null, voice: bia() }).pencil).toBeNull();
    expect(drawReducer(on, { type: 'pencil', sharerId: ANA, voice: bia({ watching: [] }) })).toBe(on);
  });

  it('follows screen.drawAllow: off hides my pencil on that share; on again lets it back', () => {
    const drawing = drawReducer(on, { type: 'pencil', sharerId: ANA, voice: bia() });
    const off = drawReducer(drawing, { type: 'allow', channelId: 'VC1', sharerId: ANA, allow: false });
    expect(off).toEqual({ available: true, off: [shareKey('VC1', ANA)], pencil: null });
    expect(drawReducer(off, { type: 'allow', channelId: 'VC1', sharerId: ANA, allow: false })).toBe(off);
    const back = drawReducer(off, { type: 'allow', channelId: 'VC1', sharerId: ANA, allow: true });
    expect(back.off).toEqual([]);
    expect(drawReducer(back, { type: 'pencil', sharerId: ANA, voice: bia() }).pencil).toBe(ANA);
    // Someone else's share being turned off leaves my pencil alone.
    expect(drawReducer(drawing, { type: 'allow', channelId: 'VC1', sharerId: BIA, allow: false }).pencil).toBe(ANA);
  });

  it('forgets "off" when the share ends, so the next share starts allowed', () => {
    const off = drawReducer(on, { type: 'allow', channelId: 'VC1', sharerId: ANA, allow: false });
    expect(drawReducer(off, { type: 'voice', voice: bia() })).toBe(off);
    const ended = drawReducer(off, { type: 'voice', voice: bia({ channels: { VC1: [person(ANA), person(BIA)] } }) });
    expect(ended.off).toEqual([]);
  });

  it('drops the pencil when I stop watching, leave the call or the share ends', () => {
    const drawing = drawReducer(on, { type: 'pencil', sharerId: ANA, voice: bia() });
    expect(drawReducer(drawing, { type: 'voice', voice: bia() })).toBe(drawing);
    expect(drawReducer(drawing, { type: 'voice', voice: bia({ watching: [] }) }).pencil).toBeNull();
    expect(drawReducer(drawing, { type: 'voice', voice: bia({ call: { status: 'idle', channelId: null } }) }).pencil).toBeNull();
    expect(drawReducer(drawing, { type: 'voice', voice: bia({ channels: { VC1: [person(BIA)] } }) }).pencil).toBeNull();
  });
});

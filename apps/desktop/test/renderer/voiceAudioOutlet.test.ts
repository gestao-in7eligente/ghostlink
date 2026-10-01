// The audio outlet's bookkeeping (createAudioOutlet; dom.ts only gives it the hidden box).
import type { RemoteTrack } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { createAudioOutlet } from '../../src/renderer/features/voice/audioOutlet.js';

class FakeElement {
  readonly dataset: Record<string, string> = {};
  removed = false;
  remove(): void {
    this.removed = true;
  }
}

/** A remote track the way LiveKit leaves it: by the time TrackUnsubscribed fires, it already detached itself. */
class FakeRemoteTrack {
  readonly elements: FakeElement[] = [];
  readonly detachedFrom: FakeElement[] = [];
  attach(): FakeElement {
    const el = new FakeElement();
    this.elements.push(el);
    return el;
  }
  detach(el?: FakeElement): FakeElement[] {
    if (el) this.detachedFrom.push(el);
    return [];
  }
}

const BIA = 'b'.repeat(32);
const asTrack = (t: FakeRemoteTrack) => t as unknown as RemoteTrack;

function outlet() {
  const box: unknown[] = [];
  return { box, outlet: createAudioOutlet(() => ({ appendChild: (el) => box.push(el) })) };
}

describe('the audio outlet', () => {
  it('marks a voice and a stream’s sound apart, in the hidden box', () => {
    const { box, outlet: o } = outlet();
    const voice = new FakeRemoteTrack();
    const screen = new FakeRemoteTrack();
    o.attach(asTrack(voice), BIA);
    o.attach(asTrack(screen), BIA, 'screen');
    expect(voice.elements[0]!.dataset).toEqual({ voiceTrack: 'remote', voiceUser: BIA });
    expect(screen.elements[0]!.dataset).toEqual({ voiceTrack: 'screen', screenUser: BIA });
    expect(box).toEqual([voice.elements[0], screen.elements[0]]);
  });

  it('removes the element it created even though LiveKit already detached the track (Unsubscribed comes after)', () => {
    const { outlet: o } = outlet();
    const track = new FakeRemoteTrack();
    o.attach(asTrack(track), BIA, 'screen');
    o.detach(asTrack(track));
    expect(track.elements[0]!.removed).toBe(true);
    expect(track.detachedFrom).toEqual([track.elements[0]]);
  });

  it('detachAll removes every element; detaching again does nothing', () => {
    const { outlet: o } = outlet();
    const a = new FakeRemoteTrack();
    const b = new FakeRemoteTrack();
    o.attach(asTrack(a), BIA);
    o.attach(asTrack(b), BIA, 'screen');
    o.detachAll();
    expect([a.elements[0]!.removed, b.elements[0]!.removed]).toEqual([true, true]);
    o.detach(asTrack(a));
    expect(a.detachedFrom).toHaveLength(1);
  });

  it('the same track attached twice keeps a single element', () => {
    const { box, outlet: o } = outlet();
    const track = new FakeRemoteTrack();
    o.attach(asTrack(track), BIA);
    o.attach(asTrack(track), BIA);
    expect(track.elements[0]!.removed).toBe(true);
    expect(box).toHaveLength(2);
    o.detach(asTrack(track));
    expect(track.elements[1]!.removed).toBe(true);
  });
});

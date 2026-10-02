import { describe, expect, it, vi } from 'vitest';
import {
  CallWindowLifecycle,
  NO_FEATURED_MEMORY,
  chooseFeatured,
  peopleRow,
  type FeaturedInput,
  type FeaturedMemory,
} from '../../src/renderer/features/voice/callWindowModel.js';

const ME = 'me';
const ANA = 'ana';
const BIA = 'bia';
const CAIO = 'caio';

/** Looks one after another, as the window renders: each look remembers what the last one saw. */
function looks(...inputs: Partial<FeaturedInput>[]) {
  let memory: FeaturedMemory = NO_FEATURED_MEMORY;
  return inputs.map((input) => {
    const out = chooseFeatured({ participants: [ME, ANA, BIA], speaking: [], cameras: [], self: ME, ...input }, memory);
    memory = out.memory;
    return out.featured;
  });
}

describe('the mini window: who the video area shows (spec §2.2)', () => {
  it('shows the camera of whoever speaks with it on, me included', () => {
    expect(looks({ speaking: [ANA], cameras: [ANA, BIA] })).toEqual([{ userId: ANA, camera: true, speaking: true }]);
    expect(looks({ speaking: [ME], cameras: [ME, ANA] })).toEqual([{ userId: ME, camera: true, speaking: true }]);
  });

  it('stays on the last one who spoke with the camera on while they are quiet, or someone speaks without one', () => {
    expect(looks({ speaking: [BIA], cameras: [ANA, BIA] }, { speaking: [], cameras: [ANA, BIA] }, { speaking: [ANA], cameras: [BIA] })).toEqual([
      { userId: BIA, camera: true, speaking: true },
      { userId: BIA, camera: true, speaking: false },
      { userId: BIA, camera: true, speaking: false },
    ]);
  });

  it('moves to the next one who speaks with a camera, and does not jump while two speak at once', () => {
    expect(
      looks({ speaking: [ANA], cameras: [ANA, BIA] }, { speaking: [BIA, ANA], cameras: [ANA, BIA] }, { speaking: [BIA], cameras: [ANA, BIA] }),
    ).toEqual([
      { userId: ANA, camera: true, speaking: true },
      { userId: ANA, camera: true, speaking: true },
      { userId: BIA, camera: true, speaking: true },
    ]);
  });

  it("with cameras on but nobody having spoken with one, shows someone else's before mine", () => {
    expect(looks({ cameras: [ME, BIA] })).toEqual([{ userId: BIA, camera: true, speaking: false }]);
    expect(looks({ cameras: [ME] })).toEqual([{ userId: ME, camera: true, speaking: false }]);
  });

  it('leaves a camera that went off (or someone who left) for another camera', () => {
    expect(looks({ speaking: [ANA], cameras: [ANA, BIA] }, { cameras: [BIA] }, { participants: [ME, BIA], cameras: [ANA, BIA] })).toEqual([
      { userId: ANA, camera: true, speaking: true },
      { userId: BIA, camera: true, speaking: false },
      { userId: BIA, camera: true, speaking: false },
    ]);
  });

  it('with no camera on, shows the photo of whoever speaks, then of the last one who spoke', () => {
    expect(looks({ speaking: [BIA] }, {}, { speaking: [ME] }, {})).toEqual([
      { userId: BIA, camera: false, speaking: true },
      { userId: BIA, camera: false, speaking: false },
      { userId: ME, camera: false, speaking: true },
      { userId: ME, camera: false, speaking: false },
    ]);
  });

  it('with nobody having spoken, shows someone else in the call, else me; nobody in the call: nothing', () => {
    expect(looks({})).toEqual([{ userId: ANA, camera: false, speaking: false }]);
    expect(looks({ participants: [ME] })).toEqual([{ userId: ME, camera: false, speaking: false }]);
    expect(looks({ participants: [] })).toEqual([null]);
  });

  it('forgets the last one who spoke once they left the call', () => {
    expect(looks({ speaking: [BIA] }, { participants: [ME, ANA] })).toEqual([
      { userId: BIA, camera: false, speaking: true },
      { userId: ANA, camera: false, speaking: false },
    ]);
  });

  it('ignores speakers and cameras of people no longer in the call', () => {
    expect(looks({ participants: [ME, ANA], speaking: [CAIO], cameras: [CAIO] })).toEqual([{ userId: ANA, camera: false, speaking: false }]);
  });
});

describe('the row of people', () => {
  it('shows up to six photos, then "+N"', () => {
    expect(peopleRow(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
    expect(peopleRow(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ shown: ['a', 'b', 'c', 'd', 'e', 'f'], more: 0 });
    expect(peopleRow(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual({ shown: ['a', 'b', 'c', 'd', 'e', 'f'], more: 2 });
  });
});

describe('the mini window opens and closes with my share', () => {
  function setup(opens = true) {
    const ops = { open: vi.fn(() => opens), close: vi.fn() };
    return { ops, lifecycle: new CallWindowLifecycle(ops) };
  }

  it('opens when my share starts and closes when it ends', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(false);
    expect(ops.open).not.toHaveBeenCalled();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(true);
    lifecycle.update(true); // nothing new
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    expect(ops.close).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(false);
  });

  it('✕ closes it while the share goes on; the next share opens it again', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.dismiss();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    expect(ops.close).toHaveBeenCalledOnce(); // already closed
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('closed by other means (Alt+F4) counts as ✕', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.gone();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.gone(); // once
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    lifecycle.update(false);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('a refused window is not asked for again during the same share', () => {
    const { ops, lifecycle } = setup(false);
    lifecycle.update(true);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
    expect(lifecycle.isOpen).toBe(false);
    lifecycle.update(false);
    expect(ops.close).not.toHaveBeenCalled();
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledTimes(2);
  });

  it('closes for good when the page goes', () => {
    const { ops, lifecycle } = setup();
    lifecycle.update(true);
    lifecycle.dispose();
    expect(ops.close).toHaveBeenCalledOnce();
    lifecycle.update(false);
    lifecycle.update(true);
    expect(ops.open).toHaveBeenCalledOnce();
  });
});

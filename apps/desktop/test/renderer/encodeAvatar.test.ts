import { describe, expect, it } from 'vitest';
import { AVATAR_LIMITS, type ImageMime } from '@ghostlink/shared';
import {
  AvatarEncodeError,
  encodeAvatar,
  frameDelay,
  openAvatarFile,
  type AvatarCodecs,
  type DecodedImage,
  type GifWriter,
} from '../../src/renderer/features/profile/encodeAvatar.js';

/** Just enough of a PNG for imageInfo: the signature and the IHDR sides. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function gifHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  new DataView(b.buffer).setUint16(6, width, true);
  new DataView(b.buffer).setUint16(8, height, true);
  return b;
}

interface Fake {
  codecs: AvatarCodecs<string>;
  /** What happened, in order. */
  log: string[];
  /** Frames handed out and not closed yet. */
  open: Set<string>;
  gifSizePerFrame: number;
  finalGifSize: number | null;
}

function fake({ width = 300, height = 200, frames = 1, durations = [] as number[], decodeFails = false, frameFails = false } = {}): Fake {
  const state: Fake = { codecs: null as unknown as AvatarCodecs<string>, log: [], open: new Set(), gifSizePerFrame: 1000, finalGifSize: null };
  const image: DecodedImage<string> = {
    width,
    height,
    frameCount: frames,
    frame: async (index) => {
      if (frameFails) throw new Error('corrupt frame');
      const name = `f${index}`;
      state.log.push(`decode ${name}`);
      state.open.add(name);
      return { image: name, durationMs: durations[index] ?? 0, close: () => state.open.delete(name) };
    },
    close: () => state.log.push('close decoder'),
  };
  state.codecs = {
    decode: async (bytes: Uint8Array, mime: ImageMime) => {
      state.log.push(`open ${mime} ${bytes.length}`);
      if (decodeFails) throw new Error('not an image');
      return image;
    },
    webp: async (img, crop, side, quality) => {
      state.log.push(`webp ${img} ${crop.x},${crop.y},${crop.side} ${side} ${quality}`);
      return new Uint8Array([1, 2, 3]);
    },
    rgba: (img, crop, side) => {
      state.log.push(`rgba ${img} ${crop.side} ${side}`);
      return new Uint8Array(4);
    },
    gif: (side) => {
      state.log.push(`gif ${side}`);
      let frames = 0;
      const writer: GifWriter = {
        add: (_rgba, delayMs) => {
          frames++;
          state.log.push(`add ${delayMs}`);
        },
        get size() {
          return frames * state.gifSizePerFrame;
        },
        finish: () => new Uint8Array(state.finalGifSize ?? frames * state.gifSizePerFrame),
      };
      return writer;
    },
  };
  return state;
}

const CROP = { x: 50, y: 0, side: 200 };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    expect(e).toBeInstanceOf(AvatarEncodeError);
    return (e as AvatarEncodeError).code;
  }
}

describe('openAvatarFile (before the crop modal opens)', () => {
  it('reads the size and whether it moves, and closes the decoder', async () => {
    const still = fake();
    expect(await openAvatarFile(pngHeader(300, 200), still.codecs)).toEqual({ mime: 'image/png', width: 300, height: 200, animated: false });
    expect(still.log).toEqual(['open image/png 33', 'decode f0', 'close decoder']);
    expect(still.open.size).toBe(0);

    const moving = fake({ width: 64, height: 64, frames: 12 });
    expect(await openAvatarFile(gifHeader(64, 64), moving.codecs)).toMatchObject({ mime: 'image/gif', animated: true });
  });

  it('refuses a file above 10 MB without decoding it', async () => {
    const f = fake();
    const big = new Uint8Array(AVATAR_LIMITS.inputMaxBytes + 1);
    big.set(pngHeader(300, 200));
    expect(await codeOf(openAvatarFile(big, f.codecs))).toBe('UNREADABLE');
    expect(f.log).toEqual([]);
  });

  it('refuses an empty file, something that is not PNG/JPEG/WebP/GIF, or a file that does not decode', async () => {
    expect(await codeOf(openAvatarFile(new Uint8Array(0), fake().codecs))).toBe('UNREADABLE');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(await codeOf(openAvatarFile(svg, fake().codecs))).toBe('UNREADABLE');
    expect(await codeOf(openAvatarFile(pngHeader(300, 200), fake({ decodeFails: true }).codecs))).toBe('UNREADABLE');
    const broken = fake({ frameFails: true });
    expect(await codeOf(openAvatarFile(pngHeader(300, 200), broken.codecs))).toBe('UNREADABLE');
    expect(broken.log.at(-1)).toBe('close decoder');
  });
});

describe('encodeAvatar (spec §2: still → WebP, animated → GIF)', () => {
  it('a still image becomes a 256×256 WebP at quality 0.9', async () => {
    const f = fake();
    const out = await encodeAvatar({ bytes: pngHeader(300, 200), mime: 'image/png' }, CROP, f.codecs);
    expect(out).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/webp' });
    expect(f.log).toEqual(['open image/png 33', 'decode f0', 'webp f0 50,0,200 256 0.9', 'close decoder']);
    expect(f.open.size).toBe(0);
  });

  it('a GIF with a single frame takes the still path', async () => {
    const f = fake({ frames: 1 });
    const out = await encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs);
    expect(out.mime).toBe('image/webp');
    expect(f.log.some((l) => l.startsWith('gif'))).toBe(false);
  });

  it('an animated image becomes a GIF, frame by frame with its durations', async () => {
    const f = fake({ frames: 3, durations: [40, 0, 120] });
    const out = await encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs);
    expect(out.mime).toBe('image/gif');
    expect(out.bytes.length).toBe(3000);
    expect(f.log).toEqual([
      'open image/gif 13',
      'gif 256',
      'decode f0',
      'rgba f0 200 256',
      'add 40',
      'decode f1',
      'rgba f1 200 256',
      'add 100',
      'decode f2',
      'rgba f2 200 256',
      'add 120',
      'close decoder',
    ]);
    expect(f.open.size).toBe(0);
  });

  it('keeps at most 300 frames; the rest is cut', async () => {
    const f = fake({ frames: 1000 });
    f.gifSizePerFrame = 10;
    await encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs);
    expect(f.log.filter((l) => l.startsWith('add'))).toHaveLength(AVATAR_LIMITS.maxFrames);
    expect(f.log).not.toContain(`decode f${AVATAR_LIMITS.maxFrames}`);
  });

  it('refuses a GIF above 2 MB as soon as it gets there, and releases everything', async () => {
    const f = fake({ frames: 100 });
    f.gifSizePerFrame = 300_000; // the 7th frame passes 2 MB
    expect(await codeOf(encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs))).toBe('TOO_LARGE');
    expect(f.log.filter((l) => l.startsWith('add'))).toHaveLength(7);
    expect(f.log.at(-1)).toBe('close decoder');
    expect(f.open.size).toBe(0);
  });

  it('refuses a finished GIF above 2 MB', async () => {
    const f = fake({ frames: 2 });
    f.finalGifSize = AVATAR_LIMITS.maxBytes + 1;
    expect(await codeOf(encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs))).toBe('TOO_LARGE');
  });

  it('a file that stops decoding is unreadable', async () => {
    expect(await codeOf(encodeAvatar({ bytes: pngHeader(300, 200), mime: 'image/png' }, CROP, fake({ decodeFails: true }).codecs))).toBe('UNREADABLE');
    const f = fake({ frames: 4, frameFails: true });
    expect(await codeOf(encodeAvatar({ bytes: gifHeader(300, 200), mime: 'image/gif' }, CROP, f.codecs))).toBe('UNREADABLE');
    expect(f.log.at(-1)).toBe('close decoder');
  });
});

describe('frameDelay', () => {
  it('keeps real durations, defaults a missing one to 100 ms, and never goes under 20 ms', () => {
    expect(frameDelay(70)).toBe(70);
    expect(frameDelay(0)).toBe(100);
    expect(frameDelay(Number.NaN)).toBe(100);
    expect(frameDelay(-5)).toBe(100);
    // Browsers play 10 ms GIF frames at 100 ms; 20 ms is the fastest that plays as written.
    expect(frameDelay(5)).toBe(20);
    expect(frameDelay(16.7)).toBe(20);
  });
});

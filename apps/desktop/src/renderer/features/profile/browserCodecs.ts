// The app's decoders and encoders for the profile photo (the decisions are in encodeAvatar.ts):
// WebCodecs' ImageDecoder for animated GIF/WebP, frame by frame with durations;
// createImageBitmap for still images (it applies a JPEG's EXIF orientation, like the <img>
// in the crop modal); OffscreenCanvas for the crop and the WebP; gifenc (MIT) for the GIF.
import { GIFEncoder, applyPalette, quantize, type Palette, type PaletteFormat } from 'gifenc';
import type { ImageMime } from '@ghostlink/shared';
import type { CropSquare } from './cropMath.js';
import type { AvatarCodecs, DecodedImage, GifWriter } from './encodeAvatar.js';

type Drawable = ImageBitmap | VideoFrame;

/** A copy backed by its own ArrayBuffer (what Blob and ImageDecoder take). */
const own = (bytes: Uint8Array) => new Uint8Array(bytes);

async function decode(bytes: Uint8Array, mime: ImageMime): Promise<DecodedImage<Drawable>> {
  const decoder = new ImageDecoder({ data: own(bytes), type: mime });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track?.animated ? track.frameCount : 1;
    if (frameCount > 1) {
      const first = await decoder.decode({ frameIndex: 0 });
      const { displayWidth: width, displayHeight: height } = first.image;
      first.image.close();
      return {
        width,
        height,
        frameCount,
        frame: async (index) => {
          const { image } = await decoder.decode({ frameIndex: index });
          return { image, durationMs: (image.duration ?? 0) / 1000, close: () => image.close() };
        },
        close: () => decoder.close(),
      };
    }
  } catch (e) {
    decoder.close();
    throw e;
  }
  decoder.close();
  const bitmap = await createImageBitmap(new Blob([own(bytes)], { type: mime }));
  return {
    width: bitmap.width,
    height: bitmap.height,
    frameCount: 1,
    frame: async () => ({ image: bitmap, durationMs: 0, close: () => {} }),
    close: () => bitmap.close(),
  };
}

function context(side: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(side, side).getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('INTERNAL');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

function draw(ctx: OffscreenCanvasRenderingContext2D, image: Drawable, crop: CropSquare, side: number): void {
  ctx.clearRect(0, 0, side, side);
  ctx.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, side, side);
}

/** True when some pixel is more than half transparent (the GIF then gets a transparent color). */
function seeThrough(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 128) return true;
  return false;
}

function gifWriter(side: number): GifWriter {
  const gif = GIFEncoder();
  return {
    add(rgba, delayMs) {
      const alpha = seeThrough(rgba);
      // One palette per frame (the first one is the global table). Opaque frames build it from a
      // 4-bit histogram, ~14× faster than 5-6-5 (≈30 ms against ≈400 ms for a 256×256 photo frame,
      // measured) for the same error, then map the pixels at 5-6-5.
      const palette: Palette = alpha ? quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true }) : quantize(rgba, 256, { format: 'rgb444' });
      const format: PaletteFormat = alpha ? 'rgba4444' : 'rgb565';
      const index = applyPalette(rgba, palette, format);
      let transparentIndex = -1;
      if (alpha) {
        transparentIndex = palette.findIndex((c) => c[3] === 0);
        // Every fully transparent entry becomes the one transparent index.
        if (transparentIndex >= 0) {
          for (let i = 0; i < index.length; i++) if (palette[index[i]!]![3] === 0) index[i] = transparentIndex;
        }
      }
      gif.writeFrame(index, side, side, { palette, delay: delayMs, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex) });
    },
    get size() {
      return gif.bytesView().length;
    },
    finish() {
      gif.finish();
      return gif.bytes();
    },
  };
}

let rgbaContext: { side: number; ctx: OffscreenCanvasRenderingContext2D } | null = null;

export const browserCodecs: AvatarCodecs<Drawable> = {
  decode,
  async webp(image, crop, side, quality) {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('INTERNAL');
    ctx.imageSmoothingQuality = 'high';
    draw(ctx, image, crop, side);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    // A browser without a WebP encoder would hand back a PNG, which main refuses.
    if (blob.type !== 'image/webp') throw new Error('INTERNAL');
    return new Uint8Array(await blob.arrayBuffer());
  },
  rgba(image, crop, side) {
    if (rgbaContext?.side !== side) rgbaContext = { side, ctx: context(side) };
    draw(rgbaContext.ctx, image, crop, side);
    return rgbaContext.ctx.getImageData(0, 0, side, side).data;
  },
  gif: gifWriter,
};

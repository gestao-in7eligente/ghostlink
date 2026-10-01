// gifenc 1.0.3 ships no types: the part browserCodecs.ts uses (https://github.com/mattdesl/gifenc#api).
declare module 'gifenc' {
  export type PaletteFormat = 'rgb565' | 'rgb444' | 'rgba4444';
  /** [r, g, b] or, with rgba4444, [r, g, b, a]. */
  export type Palette = number[][];

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: PaletteFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number },
  ): Palette;

  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: PaletteFormat): Uint8Array;

  export interface GifStream {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number },
    ): void;
    finish(): void;
    /** A copy of the bytes written so far. */
    bytes(): Uint8Array;
    /** A view of the bytes written so far (no copy). */
    bytesView(): Uint8Array;
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifStream;
}

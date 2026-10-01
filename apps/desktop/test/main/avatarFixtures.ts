// Image bytes for the avatar tests. Only the headers are real (imageInfo reads nothing else);
// `fill` makes photos with the same type and sides differ, so their hashes differ.
import { createHash } from 'node:crypto';

function sized(header: number[], total: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(total, header.length)).fill(fill & 0xff);
  bytes.set(header);
  return bytes;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** An extended (VP8X) WebP header. */
export function webp(width = 256, height = width, opts: { size?: number; fill?: number } = {}): Uint8Array {
  const header = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  return sized(header, opts.size ?? 64, opts.fill ?? 1);
}

export function gif(width = 256, height = width, opts: { size?: number; fill?: number } = {}): Uint8Array {
  return sized([...ascii('GIF89a'), ...u16le(width), ...u16le(height)], opts.size ?? 64, opts.fill ?? 2);
}

export function png(width = 256, height = width, opts: { size?: number; fill?: number } = {}): Uint8Array {
  const header = [0x89, ...ascii('PNG\r\n\x1a\n'), 0, 0, 0, 13, ...ascii('IHDR'), ...u32be(width), ...u32be(height)];
  return sized(header, opts.size ?? 64, opts.fill ?? 3);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

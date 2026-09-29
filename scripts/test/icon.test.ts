import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// electron-builder 26 rasterizes this SVG itself (its checksum-pinned WASM icon tool) into the
// Windows .ico (16–256 px) and the macOS .icns (up to 1024 px): no PNG is committed.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const svg = read('../../apps/desktop/build/icon.svg');
const mark = read('../../apps/desktop/src/renderer/components/GhostMark.tsx');
const tokens = read('../../apps/desktop/src/renderer/styles/tokens.css');

const ghostPath = svg.match(/<path id="ghost" d="([^"]+)"/)?.[1];
const eyes = [...svg.matchAll(/<ellipse cx="(\d+)" cy="(\d+)" rx="(\d+)" ry="(\d+)" fill="#1e1f22"\/>/g)].map((m) => m.slice(1).map(Number));

describe('apps/desktop/build/icon.svg', () => {
  it('is a 1024×1024 drawing', () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1024" height="1024" viewBox="0 0 1024 1024">/);
  });

  it('is self-contained, so it renders the same on every build machine', () => {
    // No fonts (text renders differently per machine), no external or embedded images, no scripts.
    expect(svg).not.toMatch(/<(text|image|script|foreignObject|style)\b/);
    const hrefs = [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^#[\w-]+$/);
    for (const [, id] of [...svg.matchAll(/(?:href="#|url\(#)([\w-]+)/g)]) expect(svg, id).toContain(`id="${id}"`);
  });

  it('is a white ghost with two dark eyes on a blurple rounded tile (radius ~22%)', () => {
    const tile = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="#5865f2"\/>/);
    expect(tile).not.toBeNull();
    const [, , , width, height, rx] = tile!.map(Number);
    expect(width).toBe(height);
    expect(rx! / width!).toBeGreaterThan(0.2);
    expect(rx! / width!).toBeLessThan(0.24);
    expect(svg).toContain('<use href="#ghost" fill="#ffffff"/>');
    expect(eyes).toHaveLength(2);
    // Old placeholder palette (spectral cyan) must be gone.
    expect(svg).not.toMatch(/#(5eead4|2dd4bf|99f6e4|042f2a)/i);
  });

  it('keeps the ghost about 62% of the icon height, eyes slightly above the center', () => {
    // "M<left> <sideBottom>V<domeCenter>A<radius> … V<sideBottom>A<lobeRadius> …"
    const n = [...ghostPath!.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const top = n[2]! - n[3]!;
    const bottom = n[1]! + n[11]!;
    expect((bottom - top) / 1024).toBeGreaterThan(0.58);
    expect((bottom - top) / 1024).toBeLessThan(0.66);
    for (const [cx, cy] of eyes) {
      expect(cy).toBeLessThan(512);
      expect(Math.abs(cx! - 512)).toBeGreaterThan(64); // separate eyes even at 16×16
    }
  });
});

describe('renderer brand mark', () => {
  it('draws the same ghost as the app icon', () => {
    expect(mark).toContain(`'${ghostPath}'`);
    for (const [cx, cy, rx, ry] of eyes) expect(mark).toContain(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#1e1f22" />`);
  });

  it('uses the blurple accent tokens', () => {
    expect(tokens).toMatch(/--accent: #5865f2;/);
    expect(tokens).toMatch(/--accent-hover: #4752c4;/);
    expect(tokens).toMatch(/--accent-ink: #ffffff;/);
    expect(tokens).not.toMatch(/#(5eead4|99f6e4|042f2a)|94 234 212|cyan/i);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// electron-builder 26 rasterizes this SVG itself (its checksum-pinned WASM icon tool) into the
// Windows .ico (16–256 px) and the macOS .icns (up to 1024 px): no PNG is committed.
const svg = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/icon.svg', import.meta.url)), 'utf8');

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

  it('uses the spec §11 palette: near-black tile, spectral cyan', () => {
    expect(svg).toContain('stop-color="#161a20"');
    expect(svg).toContain('stop-color="#0b0d10"');
    expect(svg).toContain('stroke="#5eead4"');
  });
});

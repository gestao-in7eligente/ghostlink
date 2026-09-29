import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGS } from '../../src/renderer/i18n/index.js';

const voiceDir = fileURLToPath(new URL('../../src/renderer/features/voice/', import.meta.url));

describe('voice feature public API', () => {
  it('has no provisional sandbox screen any more (the main layout hosts the voice slots)', () => {
    const index = readFileSync(`${voiceDir}index.ts`, 'utf8');
    expect(index).toMatch(/export const voiceSlots\b/);
    expect(index).not.toMatch(/Sandbox/);
    expect(existsSync(`${voiceDir}VoiceSandbox.tsx`)).toBe(false);
    expect(existsSync(`${voiceDir}sandbox.module.css`)).toBe(false);
  });

  it('keeps no texts for the removed sandbox', () => {
    for (const catalog of Object.values(CATALOGS)) expect(Object.keys(catalog).filter((k) => k.startsWith('voice.sandbox.'))).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const plist = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/entitlements.mac.plist', import.meta.url)), 'utf8');

describe('apps/desktop/build/entitlements.mac.plist', () => {
  it('is a single plist dictionary', () => {
    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\r?\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/);
    expect(plist.match(/<plist version="1\.0">/g)).toHaveLength(1);
    expect(plist.match(/<dict>/g)).toHaveLength(1);
  });

  it('grants exactly the five spec §15 entitlements, all true', () => {
    // The file replaces electron-builder's template, so the three cs.* keys must be repeated here.
    const entries = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
    expect(entries).toEqual([
      ['com.apple.security.cs.allow-jit', 'true'],
      ['com.apple.security.cs.allow-unsigned-executable-memory', 'true'],
      ['com.apple.security.cs.disable-library-validation', 'true'],
      ['com.apple.security.device.audio-input', 'true'],
      ['com.apple.security.device.camera', 'true'],
    ]);
  });

  it('grants nothing else (no debugger attach, no DYLD injection, no sandbox exceptions)', () => {
    expect(plist.match(/<key>/g)).toHaveLength(5);
    expect(plist).not.toMatch(/get-task-allow|allow-dyld-environment-variables|disable-executable-page-protection/);
  });
});

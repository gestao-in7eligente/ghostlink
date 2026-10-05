import { describe, expect, it } from 'vitest';
import { UPDATE_CHANNEL_MAX_URL, isUpdateChannelUrl, updateChannelWelcomeSchema } from '../src/updateChannel.js';

const CHANNEL = 'https://host.example/updates/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY/';

describe('isUpdateChannelUrl', () => {
  it('accepts an https URL no longer than the bound', () => {
    expect(isUpdateChannelUrl(CHANNEL)).toBe(true);
    expect(isUpdateChannelUrl('https://a/')).toBe(true);
  });

  it('refuses a non-https URL, an over-long one, and anything that is not a URL string', () => {
    expect(isUpdateChannelUrl('http://host.example/updates/x/')).toBe(false);
    expect(isUpdateChannelUrl(`https://host.example/${'a'.repeat(UPDATE_CHANNEL_MAX_URL)}`)).toBe(false);
    expect(isUpdateChannelUrl('https://')).toBe(false); // not a parseable URL
    expect(isUpdateChannelUrl('not a url')).toBe(false);
    for (const bad of [undefined, null, 7, {}, ['https://a/']]) expect(isUpdateChannelUrl(bad)).toBe(false);
  });
});

describe('updateChannelWelcomeSchema (a signed update channel a server may advertise)', () => {
  it('accepts a well-formed channel and ignores extra fields', () => {
    expect(updateChannelWelcomeSchema.parse({ url: CHANNEL })).toEqual({ url: CHANNEL });
    expect(updateChannelWelcomeSchema.parse({ url: CHANNEL, extra: 'ignored', nested: { x: 1 } })).toEqual({ url: CHANNEL });
  });

  it('drops a bad url so it becomes absent (never throws on a bad value)', () => {
    expect(updateChannelWelcomeSchema.parse({ url: 'http://host.example/updates/x/' }).url).toBeUndefined();
    expect(updateChannelWelcomeSchema.parse({ url: `https://h/${'a'.repeat(UPDATE_CHANNEL_MAX_URL)}` }).url).toBeUndefined();
    expect(updateChannelWelcomeSchema.parse({ url: 7 }).url).toBeUndefined();
    expect(updateChannelWelcomeSchema.parse({}).url).toBeUndefined();
  });

  it('fails safeParse for a non-object', () => {
    for (const bad of [undefined, null, 'https://a/', 7, []]) expect(updateChannelWelcomeSchema.safeParse(bad).success).toBe(false);
  });
});

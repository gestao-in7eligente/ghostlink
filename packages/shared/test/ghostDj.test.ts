import { describe, expect, it } from 'vitest';
import { GHOST_DJ_EQ_BANDS, GHOST_DJ_EQ_PRESETS, ghostDjControlSchema, ghostDjEqSchema, ghostDjStateSchemaClient, ghostDjVolumeSchema } from '../src/index.js';

describe('Ghost DJ panel schemas', () => {
  it('the server takes a preset or five whole gains from -12 to 12, a volume 0-100 and four actions, nothing more', () => {
    expect(ghostDjEqSchema.parse({ preset: 'electronic' })).toEqual({ preset: 'electronic' });
    expect(ghostDjEqSchema.parse({ gains: [-12, 0, 3, 12, 1] })).toEqual({ gains: [-12, 0, 3, 12, 1] });
    for (const bad of [{ gains: [0, 0, 0, 0] }, { gains: [0, 0, 0, 0, 0.5] }, { gains: [0, 0, 0, 0, 13] }, { preset: 'custom' }, { preset: 'rock', gains: [0, 0, 0, 0, 0] }, {}]) {
      expect(ghostDjEqSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ghostDjVolumeSchema.safeParse({ volume: 101 }).success).toBe(false);
    expect(ghostDjControlSchema.safeParse({ action: 'loop' }).success).toBe(false);
    expect(Object.values(GHOST_DJ_EQ_PRESETS).every((g) => g.length === GHOST_DJ_EQ_BANDS.length)).toBe(true);
  });

  it('the app reads a state leniently: unknown keys dropped, odd values made safe', () => {
    const state = ghostDjStateSchemaClient.parse({
      channelId: 'c1',
      current: { title: 'Música', url: 'https://www.youtube.com/watch?v=x', durationSec: 200, requestedBy: 'u1', requesterName: 'Ana', extra: 1 },
      positionSec: -5,
      paused: false,
      volume: 70,
      loop: 'shuffle',
      next: [],
      queueLength: 0,
      eq: { preset: 'jazz', gains: [3, 40, 'x', -2] },
      future: true,
    });
    expect(state).toEqual({
      channelId: 'c1',
      current: { title: 'Música', url: 'https://www.youtube.com/watch?v=x', durationSec: 200, requestedBy: 'u1', requesterName: 'Ana' },
      positionSec: 0,
      paused: false,
      volume: 70,
      loop: 'off',
      next: [],
      queueLength: 0,
      eq: { preset: 'custom', gains: [3, 12, 0, -2, 0] },
    });
  });
});

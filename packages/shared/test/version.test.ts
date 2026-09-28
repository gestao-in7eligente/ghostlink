import { describe, expect, it } from 'vitest';
import { PROTOCOL, negotiateProtocol } from '../src/index.js';

describe('negotiateProtocol', () => {
  it('accepts the current protocol', () => {
    expect(negotiateProtocol(PROTOCOL.current, PROTOCOL)).toBe(true);
  });

  it('accepts every version inside [min, max] and nothing outside', () => {
    const server = { min: 2, max: 4 };
    expect([1, 2, 3, 4, 5].map((v) => negotiateProtocol(v, server))).toEqual([false, true, true, true, false]);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, 0])('rejects %s', (v) => {
    expect(negotiateProtocol(v, { min: 1, max: 1 })).toBe(false);
  });
});

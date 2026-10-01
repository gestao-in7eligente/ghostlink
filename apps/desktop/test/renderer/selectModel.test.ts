import { describe, expect, it } from 'vitest';
import { SELECT_PAGE, foldText, isTypeaheadKey, selectMove, selectTypeahead } from '../../src/renderer/layout/selectModel.js';

const NOISE = ['RNNoise — neural', 'Speex — clássico', 'GTCRN — neural alternativo', 'WebRTC (nativo)', 'Desativada'];

describe('select keys', () => {
  it('arrows move one option and stop at the ends; Home and End jump', () => {
    expect(selectMove('ArrowDown', 0, 5)).toBe(1);
    expect(selectMove('ArrowDown', 4, 5)).toBe(4);
    expect(selectMove('ArrowUp', 1, 5)).toBe(0);
    expect(selectMove('ArrowUp', 0, 5)).toBe(0);
    expect(selectMove('Home', 3, 5)).toBe(0);
    expect(selectMove('End', 1, 5)).toBe(4);
    // Nothing active yet: the first option.
    expect(selectMove('ArrowDown', -1, 5)).toBe(0);
    expect(selectMove('ArrowUp', -1, 5)).toBe(0);
  });

  it('page keys jump about a screenful', () => {
    expect(selectMove('PageDown', 0, 30)).toBe(SELECT_PAGE);
    expect(selectMove('PageDown', 25, 30)).toBe(29);
    expect(selectMove('PageUp', 20, 30)).toBe(20 - SELECT_PAGE);
    expect(selectMove('PageUp', 3, 30)).toBe(0);
  });

  it('other keys and empty lists are not moves', () => {
    expect(selectMove('Enter', 0, 5)).toBeNull();
    expect(selectMove('a', 0, 5)).toBeNull();
    expect(selectMove('ArrowDown', -1, 0)).toBeNull();
  });
});

describe('select type-ahead', () => {
  it('jumps to the option that starts with the typed letters, ignoring case and accents', () => {
    expect(selectTypeahead(NOISE, 's', 0)).toBe(1);
    expect(selectTypeahead(NOISE, 'gt', 0)).toBe(2);
    expect(selectTypeahead(NOISE, 'WEB', 0)).toBe(3);
    expect(selectTypeahead(['Português (Brasil)', 'English'], 'portu', 1)).toBe(0);
    expect(selectTypeahead(['Ásia', 'Europa'], 'a', 1)).toBe(0);
    expect(foldText('Clássico')).toBe('classico');
  });

  it('searches after the current option and wraps around', () => {
    const regions = ['US West', 'US East', 'EU West', 'Southeast Asia'];
    expect(selectTypeahead(regions, 'u', 0)).toBe(1);
    expect(selectTypeahead(regions, 'u', 1)).toBe(0);
    // The same letter again moves on; a longer name refines without leaving the match.
    expect(selectTypeahead(regions, 'uu', 0)).toBe(1);
    expect(selectTypeahead(regions, 'us w', 0)).toBe(0);
    expect(selectTypeahead(regions, 'us e', 0)).toBe(1);
  });

  it('finds nothing for letters no option starts with', () => {
    expect(selectTypeahead(NOISE, 'z', 0)).toBe(-1);
    expect(selectTypeahead(NOISE, '', 0)).toBe(-1);
    expect(selectTypeahead([], 'a', -1)).toBe(-1);
  });

  it('only plain characters type', () => {
    const key = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(isTypeaheadKey(key('s'))).toBe(true);
    expect(isTypeaheadKey(key('Á'))).toBe(true);
    expect(isTypeaheadKey(key('ArrowDown'))).toBe(false);
    expect(isTypeaheadKey(key('c', { ctrlKey: true }))).toBe(false);
    expect(isTypeaheadKey(key('v', { metaKey: true }))).toBe(false);
  });
});

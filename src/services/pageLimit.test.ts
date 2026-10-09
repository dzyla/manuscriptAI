import { describe, it, expect } from 'vitest';
import { readPageLimit, parsePageLimitInput, withPageLimit, MAX_PAGE_LIMIT } from './pageLimit';
import { createFormat } from './formatPresets';

describe('readPageLimit', () => {
  it('keeps a positive finite number up to the maximum', () => {
    for (const v of [0.5, 1, 13, 13.5, MAX_PAGE_LIMIT]) expect(readPageLimit(v)).toBe(v);
  });
  it('treats everything else as unset', () => {
    for (const v of [0, -1, NaN, Infinity, MAX_PAGE_LIMIT + 1, '13', null, undefined, {}]) expect(readPageLimit(v)).toBeNull();
  });
});

describe('parsePageLimitInput', () => {
  it('blank is unset', () => { expect(parsePageLimitInput('')).toEqual({ kind: 'unset' }); expect(parsePageLimitInput('  ')).toEqual({ kind: 'unset' }); });
  it('accepts positive numbers, rounded to two decimals', () => {
    expect(parsePageLimitInput('13')).toEqual({ kind: 'ok', value: 13 });
    expect(parsePageLimitInput('13.456')).toEqual({ kind: 'ok', value: 13.46 });
  });
  it('rejects zero, negatives, a value that rounds to zero, text and anything huge', () => {
    for (const t of ['0', '-3', '0.001', 'abc', '1e9', '1000', 'Infinity', 'NaN']) expect(parsePageLimitInput(t).kind, t).toBe('bad');
  });
});

describe('withPageLimit', () => {
  it('sets and removes the limit without touching the rest', () => {
    const f = createFormat('nih');
    const set = withPageLimit(f, 12);
    expect(set).toEqual({ ...f, pageLimitPages: 12 });
    expect('pageLimitPages' in withPageLimit(set, null)).toBe(false);
  });
});

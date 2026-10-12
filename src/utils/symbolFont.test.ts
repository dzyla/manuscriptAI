import { describe, it, expect } from 'vitest';
import { deSymbol } from './symbolFont';

describe('deSymbol', () => {
  it('turns a Symbol-font mu into a readable dose', () => {
    expect(deSymbol('5g of protein')).toBe('5µg of protein');
  });
  it('maps comparison and plus-minus symbols', () => {
    expect(deSymbol('p  0.05, 4C, 3  1')).toBe('p ≤ 0.05, 4°C, 3 ± 1');
  });
  it('drops private-use characters it does not know', () => {
    expect(deSymbol('abc')).toBe('abc');
  });
  it('leaves ordinary text alone', () => {
    expect(deSymbol('plain µg text')).toBe('plain µg text');
  });
});

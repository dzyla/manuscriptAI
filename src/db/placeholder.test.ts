import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_TEXT, isBlankText } from './placeholder';

describe('isBlankText', () => {
  it('is true for nothing and for exactly the placeholder, however its whitespace or quotes were serialised', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('  \n ')).toBe(true);
    expect(isBlankText(PLACEHOLDER_TEXT)).toBe(true);
    expect(isBlankText('Start writing your manuscript here,\n   or click "New Manuscript"  to begin\twith an IMRAD template.')).toBe(true);
    expect(isBlankText('Start writing your manuscript here, or click &quot;New Manuscript&quot; to begin with an IMRAD template.')).toBe(true);
  });
  it('is false for any text typed into, before or after it', () => {
    expect(isBlankText(PLACEHOLDER_TEXT + ' and more')).toBe(false);
    expect(isBlankText('Aims ' + PLACEHOLDER_TEXT)).toBe(false);
    expect(isBlankText('Start writing your manuscript here')).toBe(false);
  });
});

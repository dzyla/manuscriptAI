import { describe, it, expect } from 'vitest';
import { normalizeForMatch, findTextSpan } from './textMatch';

describe('normalizeForMatch', () => {
  it('normalizes unicode quotes and dashes to ascii', () => {
    const { text } = normalizeForMatch('“hello” — it’s an em–dash');
    expect(text).toBe('"hello" - it\'s an em-dash');
  });

  it('collapses runs of whitespace to single spaces', () => {
    expect(normalizeForMatch('a\n\n  b\t c').text).toBe('a b c');
  });

  it('strips citation markers by default and keeps a char map', () => {
    const { text, map } = normalizeForMatch('cells died [3] quickly');
    expect(text).toBe('cells died quickly');
    // map must index back into the original for every output char
    expect(map.length).toBe(text.length);
    expect(text[map.length - 1]).toBeDefined();
  });

  it('keeps citation markers when asked', () => {
    expect(normalizeForMatch('cells died [3] quickly', false).text).toBe('cells died [3] quickly');
  });
});

describe('findTextSpan', () => {
  const hay = 'We observed that the cells died rapidly after treatment [3].';

  it('finds an exact substring', () => {
    const m = findTextSpan(hay, 'the cells died rapidly');
    expect(m?.method).toBe('exact');
    expect(m && hay.slice(m.start, m.end)).toBe('the cells died rapidly');
  });

  it('locates a quote whose punctuation was normalized by the model', () => {
    // source uses a curly apostrophe and an em dash; model quoted with ascii
    const src = 'The team’s result was clear—robust and reproducible.';
    const m = findTextSpan(src, "The team's result was clear-robust and reproducible.");
    expect(m).toBeTruthy();
    expect(m?.method).not.toBe('exact');
  });

  it('locates a quote that dropped a citation marker', () => {
    const m = findTextSpan(hay, 'died rapidly after treatment');
    expect(m).toBeTruthy();
    expect(hay.slice(m!.start, m!.end)).toContain('died rapidly after treatment');
  });

  it('returns null for text that is not present', () => {
    expect(findTextSpan(hay, 'the mice were injected with saline')).toBeNull();
  });

  it('fuzzy-matches a lightly misquoted long span and snaps to word boundaries', () => {
    const src = 'The proposed mechanism explains the observed increase in signaling activity across all conditions tested.';
    // small paraphrase: "explains the observed rise in signaling activity across all conditions"
    const m = findTextSpan(src, 'explains the observed rise in signaling activity across all conditions');
    expect(m).toBeTruthy();
    // matched text should be real substring of source, not clipped mid-word
    expect(src).toContain(m!.matchedText);
    expect(/^\w/.test(m!.matchedText)).toBe(true);
  });
});

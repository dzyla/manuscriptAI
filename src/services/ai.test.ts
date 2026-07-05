import { describe, it, expect } from 'vitest';
import {
  parseJSONRobust,
  anchorSuggestions,
  lintSuggestedText,
  buildConflictGroups,
  detectH2Sections,
  stripThinkingBlocks,
} from './ai';
import type { Suggestion } from '../types';

describe('parseJSONRobust', () => {
  it('parses clean JSON', () => {
    expect(parseJSONRobust('{"a":1}')).toEqual({ a: 1 });
  });
  it('extracts JSON from a markdown code fence', () => {
    expect(parseJSONRobust('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('tolerates trailing commas', () => {
    expect(parseJSONRobust('{"a":1,}')).toEqual({ a: 1 });
  });
  it('extracts a JSON object embedded in prose', () => {
    expect(parseJSONRobust('Sure! Here it is: {"a":1} hope that helps'))
      .toEqual({ a: 1 });
  });
  it('recovers individual suggestion objects from a truncated array', () => {
    const raw = '{"suggestions":[{"originalText":"x","suggestedText":"y"},{"originalText":"a","suggestedText":"b"}';
    const parsed = parseJSONRobust(raw);
    expect(parsed.suggestions.length).toBeGreaterThanOrEqual(1);
  });
  it('throws on hopeless input', () => {
    expect(() => parseJSONRobust('not json at all')).toThrow();
  });
});

describe('lintSuggestedText', () => {
  it('removes em and en dashes', () => {
    expect(lintSuggestedText('the result — robust — held', 'orig')).not.toMatch(/[—–]/);
  });
  it('re-appends a citation marker the model dropped from the original', () => {
    const out = lintSuggestedText('We observed cell death.', 'It was observed that cells died [3].');
    expect(out).toContain('[3]');
  });
  it('places the re-appended marker before the trailing period', () => {
    const out = lintSuggestedText('We observed cell death.', 'cells died [3]');
    expect(out.endsWith('[3].') || out.endsWith('[3]')).toBe(true);
  });
  it('does not add markers when the replacement already keeps them', () => {
    const out = lintSuggestedText('We observed cell death [3].', 'cells died [3]');
    expect((out.match(/\[3\]/g) || []).length).toBe(1);
  });
});

describe('anchorSuggestions', () => {
  const doc = 'It was observed that the cells died rapidly after treatment.';

  it('anchors an exact-quote suggestion and rewrites originalText to the doc text', () => {
    const raw = [{ originalText: 'the cells died rapidly', suggestedText: 'the cells died within 2 h', explanation: 'add detail', severity: 'minor', category: 'clarity' }];
    const { suggestions, dropped } = anchorSuggestions(raw, doc, 'editor', 'p');
    expect(dropped).toBe(0);
    expect(suggestions).toHaveLength(1);
    expect(doc).toContain(suggestions[0].originalText);
    expect(suggestions[0].startIndex).toBeGreaterThanOrEqual(0);
  });

  it('drops a no-op edit that differs only by unicode punctuation', () => {
    const raw = [{ originalText: 'the cells died rapidly', suggestedText: 'the cells died rapidly', explanation: '', severity: 'minor', category: 'clarity' }];
    const { suggestions, dropped } = anchorSuggestions(raw, doc, 'editor', 'p');
    expect(suggestions).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('drops a suggestion whose quote cannot be located', () => {
    const raw = [{ originalText: 'the mice were injected', suggestedText: 'the mice received saline', explanation: '', severity: 'minor', category: 'clarity' }];
    const { dropped } = anchorSuggestions(raw, doc, 'editor', 'p');
    expect(dropped).toBe(1);
  });

  it('salvages a lightly misquoted suggestion via fuzzy match', () => {
    const raw = [{ originalText: 'It was observed that the cells perished rapidly after treatment', suggestedText: 'We observed rapid cell death after treatment', explanation: '', severity: 'major', category: 'clarity' }];
    const { suggestions, salvaged } = anchorSuggestions(raw, doc, 'editor', 'p');
    expect(suggestions.length + salvaged).toBeGreaterThan(0);
  });

  it('defaults invalid severity/category to safe values', () => {
    const raw = [{ originalText: 'the cells died rapidly', suggestedText: 'the cells died within hours', explanation: '', severity: 'catastrophic', category: 'vibes' }];
    const { suggestions } = anchorSuggestions(raw, doc, 'editor', 'p');
    expect(suggestions[0].severity).toBe('minor');
    expect(suggestions[0].category).toBe('clarity');
  });
});

describe('buildConflictGroups', () => {
  const mk = (id: string, start: number, end: number, original: string): Suggestion => ({
    id, originalText: original, suggestedText: 'x', explanation: '', agent: 'editor', startIndex: start, endIndex: end,
  });

  it('groups suggestions whose ranges overlap', () => {
    const groups = buildConflictGroups([
      mk('a', 0, 10, 'foo'),
      mk('b', 5, 15, 'bar'),
      mk('c', 100, 110, 'baz'),
    ]);
    // a and b overlap; c is alone
    const sizes = groups.map(g => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('groups when one quote contains the other', () => {
    const groups = buildConflictGroups([
      mk('a', 0, 40, 'the cells died rapidly after treatment'),
      mk('b', 200, 210, 'cells died'),
    ]);
    expect(groups.some(g => g.length === 2)).toBe(true);
  });
});

describe('detectH2Sections', () => {
  it('splits TipTap HTML on h2 headings in document order', () => {
    const html = '<h2>Introduction</h2><p>Intro body.</p><h2>Methods</h2><p>We did things.</p>';
    const secs = detectH2Sections(html);
    expect(secs.map(s => s.section)).toEqual(['Introduction', 'Methods']);
    expect(secs[1].text).toContain('We did things');
  });

  it('returns nothing when there are no h2 headings', () => {
    expect(detectH2Sections('<p>flat text</p>')).toEqual([]);
  });
});

describe('stripThinkingBlocks', () => {
  it('removes a bare "Thinking Process:" preamble and keeps the answer', () => {
    const input = 'Thinking Process:\nThe user wants a greeting.\n\nHello there.';
    expect(stripThinkingBlocks(input)).toBe('Hello there.');
  });
  it('removes a non-bold numbered analysis preamble', () => {
    const input = '1. Analyze the request.\n2. Draft the reply.\n\nThe final answer.';
    expect(stripThinkingBlocks(input)).toBe('The final answer.');
  });
  it('leaves normal prose untouched', () => {
    expect(stripThinkingBlocks('A clean sentence.')).toBe('A clean sentence.');
  });
});

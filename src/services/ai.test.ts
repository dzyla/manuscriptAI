import { describe, it, expect } from 'vitest';
import {
  parseJSONRobust,
  anchorSuggestions,
  lintSuggestedText,
  buildConflictGroups,
  detectH2Sections,
  stripThinkingBlocks,
  countWords,
  bestTrimCandidate,
  isAdvisoryAgent,
  ADVISORY_AGENTS,
  spansOverlap,
  dedupeAdvisories,
} from './ai';
import type { Suggestion } from '../types';
import { looksLikeThinking, isForwardContinuation } from '../../scripts/eval/checks';

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

  it('anchors an advisory suggestion with no suggestedText and keeps the recommendation', () => {
    const raw = [{ kind: 'advisory', originalText: 'the cells died rapidly', explanation: 'no measurement given', recommendation: 'report the timescale', severity: 'major', category: 'statistics' }];
    const { suggestions, dropped } = anchorSuggestions(raw, doc, 'statistician', 'p');
    expect(dropped).toBe(0);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe('advisory');
    expect(suggestions[0].suggestedText).toBe('');
    expect(suggestions[0].recommendation).toBe('report the timescale');
    expect(doc).toContain(suggestions[0].originalText);
  });

  it('does NOT drop an advisory whose quote equals the source (no no-op rule)', () => {
    const raw = [{ kind: 'advisory', originalText: 'the cells died rapidly', explanation: 'x', recommendation: 'y', severity: 'minor', category: 'statistics' }];
    const { suggestions, dropped } = anchorSuggestions(raw, doc, 'statistician', 'p');
    expect(suggestions).toHaveLength(1);
    expect(dropped).toBe(0);
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
  it('keeps an unmarked numbered list even when prose follows (chat answer, not thinking)', () => {
    const input = '1. Analyze the request.\n2. Draft the reply.\n\nThe final answer.';
    expect(stripThinkingBlocks(input)).toBe(input);
  });
  it('strips a MARKED preamble with numbered reasoning steps, keeping the answer', () => {
    const input = 'Thinking Process:\n1. The user wants a summary.\n2. Keep it short.\n\nThe study shows a clear effect.';
    expect(stripThinkingBlocks(input)).toBe('The study shows a clear effect.');
  });
  it('leaves normal prose untouched', () => {
    expect(stripThinkingBlocks('A clean sentence.')).toBe('A clean sentence.');
  });
  it('keeps an unmarked numbered-list answer with no trailing prose', () => {
    const input = '1. The intro lacks a hypothesis.\n2. Methods omit sample size.\n3. Add effect sizes.';
    expect(stripThinkingBlocks(input)).toBe(input);
  });
  it('still discards a marked thinking block that has no answer', () => {
    expect(stripThinkingBlocks('Thinking Process:\n1. Consider the ask.\n2. Formulate a reply.')).toBe('');
  });
});

describe('countWords', () => {
  it('counts whitespace-delimited words', () => {
    expect(countWords('one two   three\nfour')).toBe(4);
  });
  it('is 0 for empty/whitespace', () => {
    expect(countWords('   ')).toBe(0);
  });
});

describe('bestTrimCandidate', () => {
  const input = 'w '.repeat(100).trim(); // 100 words
  it('prefers the longest candidate that is within budget', () => {
    const under50 = 'w '.repeat(40).trim();
    const under80 = 'w '.repeat(70).trim();
    const r = bestTrimCandidate(input, [under50, under80], 80);
    expect(r.text).toBe(under80);
    expect(r.withinBudget).toBe(true);
  });
  it('falls back to the shortest candidate when none meet budget', () => {
    const c90 = 'w '.repeat(90).trim();
    const c95 = 'w '.repeat(95).trim();
    const r = bestTrimCandidate(input, [c95, c90], 80);
    expect(r.text).toBe(c90);
    expect(r.withinBudget).toBe(false);
  });
  it('never returns text longer than the input', () => {
    const grew = 'w '.repeat(150).trim();
    const r = bestTrimCandidate(input, [grew], 80);
    expect(r.text).toBe(input); // all candidates grew -> return input
    expect(r.withinBudget).toBe(false);
  });
});

describe('eval predicates', () => {
  it('looksLikeThinking flags preambles', () => {
    expect(looksLikeThinking('Thinking Process: first I will...')).toBe(true);
    expect(looksLikeThinking('Sure! Here is the continuation.')).toBe(true);
    expect(looksLikeThinking(' and then the reaction proceeds.')).toBe(false);
  });
  it('isForwardContinuation rejects a verbatim restatement', () => {
    const ctx = 'The reaction proceeds at room temperature.';
    expect(isForwardContinuation(ctx, 'The reaction proceeds at room temperature.')).toBe(false);
    expect(isForwardContinuation(ctx, ' It then yields the product.')).toBe(true);
    expect(isForwardContinuation(ctx, '')).toBe(false);
  });
});

describe('advisory agent classification', () => {
  it('marks the data-dependent agents advisory by nature', () => {
    for (const a of ['statistician', 'consistency', 'reporting', 'reviewer-2', 'citation-checker'] as const) {
      expect(ADVISORY_AGENTS.has(a)).toBe(true);
      expect(isAdvisoryAgent(a)).toBe(true);
    }
  });
  it('leaves the text-quality agents as edit agents', () => {
    for (const a of ['editor', 'researcher', 'manager'] as const) {
      expect(isAdvisoryAgent(a)).toBe(false);
    }
  });
  it('adviceOnly override makes every agent advisory', () => {
    expect(isAdvisoryAgent('editor', { adviceOnly: true } as any)).toBe(true);
    expect(isAdvisoryAgent('manager', { adviceOnly: true } as any)).toBe(true);
  });
});

describe('dedupeAdvisories', () => {
  const mk = (id: string, text: string, start: number): Suggestion => ({
    id, originalText: text, suggestedText: '', explanation: '', recommendation: 'r',
    agent: 'statistician', startIndex: start, endIndex: start + text.length,
    kind: 'advisory', severity: 'major', category: 'statistics',
  });

  it('detects overlap by containment and by index range', () => {
    expect(spansOverlap(mk('a', 'the cells died rapidly', 5), mk('b', 'cells died', 9))).toBe(true);
    expect(spansOverlap(mk('a', 'foo', 0), mk('b', 'bar', 50))).toBe(false);
  });

  it('keeps the first (detector) advisory when two flag the same span', () => {
    const detector = mk('detector-0', 'p < 0.05 in the treated group', 10);
    const llm = mk('llm-1', 'p < 0.05', 10);
    const kept = dedupeAdvisories([detector, llm]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('detector-0');
  });

  it('keeps advisories on disjoint spans', () => {
    const kept = dedupeAdvisories([mk('a', 'foo', 0), mk('b', 'bar', 100)]);
    expect(kept).toHaveLength(2);
  });
});

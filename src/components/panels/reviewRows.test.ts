import { describe, it, expect } from 'vitest';
import { reviewRows } from './reviewRows';
import { sentenceEvidence } from '../style/styleRows';
import type { Suggestion, SentenceAudit } from '../../types';

const TEXT = 'Alpha sentence here. Beta sentence here; with a semicolon. Gamma sentence here.';
const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 's1', originalText: 'Gamma sentence here.', suggestedText: 'Gamma is shorter.',
  explanation: 'Tighten it.', agent: 'editor', startIndex: 58, endIndex: 78, ...over,
});
const flag = (over: Partial<SentenceAudit> = {}): SentenceAudit =>
  ({ start: 21, end: 57, words: 7, tells: ['semicolon'], severity: 63, ...over });

describe('reviewRows', () => {
  it('orders every kind by position in the document, not by kind', () => {
    const rows = reviewRows({
      suggestions: [sug()], flagged: [flag()],
      grammar: [{ start: 0, end: 20, message: 'Consider a comma.' }],
      plainText: TEXT, appliedIds: new Set(),
    });
    expect(rows.map(r => r.kind)).toEqual(['grammar', 'style', 'suggestion']);
    expect(rows.map(r => r.start)).toEqual([0, 21, 58]);
  });

  it("carries H's evidence verbatim", () => {
    const rows = reviewRows({ suggestions: [], flagged: [flag()], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].evidence).toContain('semicolon');
    expect(rows[0].evidence).toBe(rows[0].evidence.trim());
  });

  it('offers accept and reject for a suggestion with replacement text', () => {
    const rows = reviewRows({ suggestions: [sug()], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].actions).toEqual(['accept', 'reject']);
  });

  it('offers only reject for an advisory suggestion with no replacement', () => {
    const rows = reviewRows({ suggestions: [sug({ suggestedText: '' })], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].actions).toEqual(['reject']);
  });

  it('disables a row whose span no longer matches the text', () => {
    // Review Focus 4: an import or an edit moved the text under the offsets.
    const rows = reviewRows({
      suggestions: [sug({ originalText: 'text that is no longer there' })],
      flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set(),
    });
    expect(rows[0].canAct).toBe(false);
  });

  it('disables a style row measured before a suggestion on the same span was applied', () => {
    // Review Focus 2: both rows would rewrite the same text; the second must not act on a stale span.
    const rows = reviewRows({
      suggestions: [sug({ id: 'applied', startIndex: 21, endIndex: 57, originalText: 'Beta sentence here; with a semicolon.' })],
      flagged: [flag()], grammar: [], plainText: TEXT, appliedIds: new Set(['applied']), styleCurrent: false,
    });
    const style = rows.find(r => r.kind === 'style')!;
    expect(style.canAct).toBe(false);
    expect(style.evidence).toContain('already changed');
  });

  it('returns nothing for an empty document rather than throwing', () => {
    // Review Focus 3.
    expect(reviewRows({ suggestions: [], flagged: [], grammar: [], plainText: '', appliedIds: new Set() })).toEqual([]);
  });

  it('gives every row a stable unique id', () => {
    const rows = reviewRows({ suggestions: [sug()], flagged: [flag()], grammar: [{ start: 0, end: 20, message: 'x' }], plainText: TEXT, appliedIds: new Set() });
    expect(new Set(rows.map(r => r.id)).size).toBe(3);
  });

  it('keeps an advisory flag actionable: it inserts a note rather than replacing text', () => {
    const rows = reviewRows({ suggestions: [sug({ suggestedText: '', kind: 'advisory' })], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].actions).toEqual(['accept', 'reject']);
    expect(rows[0].advisory).toBe(true);
  });

  it('finds a suggestion by its text when earlier edits moved its offsets', () => {
    const moved = 'Inserted. ' + TEXT;
    const rows = reviewRows({ suggestions: [sug()], flagged: [], grammar: [], plainText: moved, appliedIds: new Set() });
    expect(rows[0].canAct).toBe(true);
  });

  it('disables every style row while the audit describes older text, and still lists them', () => {
    const rows = reviewRows({ suggestions: [], flagged: [flag()], grammar: [], plainText: TEXT, appliedIds: new Set(), styleCurrent: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].canAct).toBe(false);
    expect(rows[0].evidence).toBe('7 words · semicolon');
  });

  it('disables a style row the editor refuses to rewrite, and says why', () => {
    const rows = reviewRows({ suggestions: [], flagged: [flag()], grammar: [], plainText: TEXT, appliedIds: new Set(), styleBlocked: new Map([['style:21-57', 'Too long.']]) });
    expect(rows[0].canAct).toBe(false);
    expect(rows[0].note).toBe('Too long.');
  });

  it('uses the same words for a flagged sentence as the style panel', () => {
    const rows = reviewRows({ suggestions: [], flagged: [flag({ words: 40, tells: [] }), flag({ start: 60, end: 70, words: 12, tells: [] })], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows.map(r => r.evidence)).toEqual(['40 words · over 35 words', '12 words · no specific pattern']);
  });

  it('handles 500 suggestions on a long document without stalling', () => {
    const text = 'A sentence of ordinary length goes here. '.repeat(1500);
    const suggestions = Array.from({ length: 500 }, (_, i) => sug({ id: `s${i}`, originalText: i % 2 ? 'A sentence of ordinary length goes here.' : `Gone text number ${i} which is not in the document`, startIndex: i * 3, endIndex: i * 3 + 5 }));
    const t0 = performance.now();
    const rows = reviewRows({ suggestions, flagged: [], grammar: [], plainText: text, appliedIds: new Set() });
    expect(rows).toHaveLength(500);
    expect(rows.filter(r => r.canAct)).toHaveLength(250);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('lets a flag measured AFTER the suggestion was applied be rewritten', () => {
    const rows = reviewRows({
      suggestions: [sug({ id: 'applied', startIndex: 21, endIndex: 57, originalText: 'Beta sentence here; with a semicolon.' })],
      flagged: [flag()], grammar: [], plainText: TEXT, appliedIds: new Set(['applied']), styleCurrent: true,
    });
    expect(rows.find(r => r.kind === 'style')!.canAct).toBe(true);
  });

  it('shows H\'s evidence exactly: labels, not tell names', () => {
    const f = flag({ tells: ['rather than', 'semicolon'], words: 12 });
    const rows = reviewRows({ suggestions: [], flagged: [f], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].evidence).toBe(sentenceEvidence(f));
    expect(rows[0].evidence).toBe('12 words · contrastive definition, semicolon');
  });

  it('shows a suggestion\'s explanation untouched', () => {
    const long = 'Tighten it by removing the second clause and moving the number first.';
    const rows = reviewRows({ suggestions: [sug({ explanation: long })], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set() });
    expect(rows[0].evidence).toBe(long);
  });

  it('orders by where the text is now, not by the stored offsets', () => {
    // B was analysed first (offset 0) but its text now sits after A's.
    const text = 'Alpha one is here. Beta two is here too.';
    const a = sug({ id: 'a', originalText: 'Alpha one is here.', startIndex: 30, endIndex: 48 });
    const b = sug({ id: 'b', originalText: 'Beta two is here too.', startIndex: 0, endIndex: 21 });
    const rows = reviewRows({ suggestions: [b, a], flagged: [], grammar: [], plainText: text, appliedIds: new Set() });
    expect(rows.map(r => r.id)).toEqual(['suggestion:a', 'suggestion:b']);
  });

  it('keeps a suggestion actionable when its quote was lightly edited (fuzzy tier)', () => {
    const quote = 'The treated cohort showed a significantly greater reduction in tumour volume';
    const text = 'Intro. The treated cohort showed a significantly greater reduction in tumor volume overall. End.';
    const rows = reviewRows({ suggestions: [sug({ originalText: quote, startIndex: 0, endIndex: quote.length })], flagged: [], grammar: [], plainText: text, appliedIds: new Set() });
    expect(rows[0].canAct).toBe(true);
  });

  it('disables a suggestion that overlaps the span of an applied one', () => {
    const applied = sug({ id: 'applied', originalText: 'Gamma sentence here.', startIndex: 59, endIndex: 79 });
    const other = sug({ id: 'other', originalText: 'Gamma sentence here.', startIndex: 59, endIndex: 79 });
    const rows = reviewRows({ suggestions: [applied, other], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set(['applied']) });
    expect(rows.map(r => r.id)).toEqual(['suggestion:other']);
    expect(rows[0].canAct).toBe(false);
  });

  it('does not list a suggestion that is already applied', () => {
    const rows = reviewRows({ suggestions: [sug({ id: 'done' })], flagged: [], grammar: [], plainText: TEXT, appliedIds: new Set(['done']) });
    expect(rows).toEqual([]);
  });

  describe('the fuzzy anchor cache never vouches for a place the text has left', () => {
    const quote = 'The treated cohort showed a significantly greater reduction in tumour volume';
    const near = 'The treated cohort showed a significantly greater reduction in tumor volume';
    const mk = (id: string) => sug({ id, originalText: quote, startIndex: 0, endIndex: quote.length });
    const other = (id: string) => sug({ id, originalText: 'Second finding is stated plainly here.', startIndex: 0, endIndex: 38 });

    it('re-resolves a remembered hit when the text moved', () => {
      const a = mk('cache-hit-a'), b = other('cache-hit-b');
      const before = `${near}. Second finding is stated plainly here.`;
      const after = `Second finding is stated plainly here. Padding words. ${near}.`;
      expect(reviewRows({ suggestions: [a, b], flagged: [], grammar: [], plainText: before, appliedIds: new Set() }).map(r => r.id)).toEqual(['suggestion:cache-hit-a', 'suggestion:cache-hit-b']);
      expect(reviewRows({ suggestions: [a, b], flagged: [], grammar: [], plainText: after, appliedIds: new Set() }).map(r => r.id)).toEqual(['suggestion:cache-hit-b', 'suggestion:cache-hit-a']);
    });

    it('drops a remembered hit when its text is gone', () => {
      const a = mk('cache-gone');
      reviewRows({ suggestions: [a], flagged: [], grammar: [], plainText: `Intro. ${near}. End.`, appliedIds: new Set() });
      const rows = reviewRows({ suggestions: [a], flagged: [], grammar: [], plainText: 'Intro. Something unrelated now. End.', appliedIds: new Set() });
      expect(rows[0].canAct).toBe(false);
    });

    it('does not reuse a miss recorded for a different document text', () => {
      const a = mk('cache-miss');
      expect(reviewRows({ suggestions: [a], flagged: [], grammar: [], plainText: 'Nothing relevant here at all.', appliedIds: new Set() })[0].canAct).toBe(false);
      expect(reviewRows({ suggestions: [a], flagged: [], grammar: [], plainText: `Now it is back. ${near}. End.`, appliedIds: new Set() })[0].canAct).toBe(true);
    });
  });
});

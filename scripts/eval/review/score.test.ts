import { describe, it, expect } from 'vitest';
import { scoreBySource, quotesOverlap, matches, assign, scoreFindings, scoreProse, sectionTitleForQuote, fromSuggestions, type NormalizedFinding } from './score';
import type { Expectation, ReviewFixture } from './fixtures/types';
import type { Suggestion } from '../../../src/types';
import { GRANT_FIXTURE, AIM3 } from './fixtures/grant';

const planted: Expectation = {
  id: 'P', checkId: 'g-rig-power', sectionTitles: ['Aim 3'], quoteHints: ['using eight mice per group'],
  keywords: /power|sample size/i, alsoIn: [{ sectionTitle: 'Rigor', mention: /aim 3/i }], note: '',
};
const trap: Expectation = {
  id: 'T', checkId: 'g-rig-power', sectionTitles: ['Rigor'], quoteHints: ['n = 12 mice per group gives 80% power'],
  keywords: /power|sample size/i, note: '',
};
const noHint: Expectation = { id: 'N', checkId: 'g-fea-pitfalls', sectionTitles: ['Aim 2'], keywords: /alternative/i, note: '' };
const fx: ReviewFixture = { id: 'f', docType: 'grant', sections: [], planted: [planted, noHint], traps: [trap] };
const f = (x: Partial<NormalizedFinding>): NormalizedFinding => ({ text: '', source: 'test', ...x });

describe('quotesOverlap', () => {
  it('accepts containment either way, ignoring case and spacing', () => {
    expect(quotesOverlap('Using  EIGHT mice per group', 'using eight mice per group')).toBe(true);
    expect(quotesOverlap('eight mice per', 'using eight mice per group')).toBe(true);
    expect(quotesOverlap('mice', 'using eight mice per group')).toBe(false);
  });

  it('accepts a short containment that is long enough to be specific', () => {
    // two space-separated tokens, but 17 characters and unmistakable
    expect(quotesOverlap('a signal from receptor-bound HN.', 'receptor-bound HN')).toBe(true);
    expect(quotesOverlap('the HN protein', 'HN')).toBe(false);
    // a milestone label: 13 characters, two tokens, unmistakable
    expect(quotesOverlap('Eliciting a response by Y6Q3 Go/No-Go.', 'Y6Q3 Go/No-Go')).toBe(true);
    // a long single word is distinctive; a short one is not
    expect(quotesOverlap('the immunogenicity data', 'immunogenicity')).toBe(true);
    expect(quotesOverlap('the group sizes', 'group')).toBe(false);
  });

  it('accepts a shared run of five words and rejects shorter ones', () => {
    expect(quotesOverlap('they will be using eight mice per group here', 'we plan using eight mice per group daily')).toBe(true);
    expect(quotesOverlap('using eight mice today', 'using eight rats today')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(quotesOverlap('', 'x')).toBe(false);
  });
});

describe('matches', () => {
  it('needs the topic: checkId or keywords', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', quote: 'using eight mice per group' }))).toBe(true);
    expect(matches(planted, f({ text: 'No power analysis.', quote: 'using eight mice per group' }))).toBe(true);
    expect(matches(planted, f({ checkId: 'g-rig-bias', text: 'Blinding missing.', quote: 'using eight mice per group' }))).toBe(false);
  });

  it('with a quote, needs the quote to overlap a hint, not just the right section', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 3', quote: 'Mice will undergo TAC' }))).toBe(false);
  });

  it('without a quote, accepts the right section', () => {
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 3' }))).toBe(true);
    expect(matches(planted, f({ checkId: 'g-rig-power', sectionTitle: 'Aim 2' }))).toBe(false);
  });

  it('accepts any quote in the section when the expectation has no hints', () => {
    expect(matches(noHint, f({ text: 'no alternative strategies', sectionTitle: 'Aim 2', quote: 'anything here' }))).toBe(true);
  });

  it('accepts an alsoIn section only when the finding mentions the cue', () => {
    expect(matches(planted, f({ text: 'Power analysis omits Aim 3.', sectionTitle: 'Rigor' }))).toBe(true);
    expect(matches(planted, f({ text: 'Power analysis is weak.', sectionTitle: 'Rigor' }))).toBe(false);
  });
});

describe('scoreFindings', () => {
  it('counts hits, misses, false alarms and unmatched findings', () => {
    const r = scoreFindings(fx, [
      f({ checkId: 'g-rig-power', quote: 'using eight mice per group' }),
      f({ checkId: 'g-rig-power', quote: 'n = 12 mice per group gives 80% power' }),
      f({ checkId: 'g-rig-power', sectionTitle: 'Rigor', text: 'Power analysis is weak.' }),
      f({ checkId: 'g-con-terms', text: 'Abbreviation undefined.', quote: 'MCU' }),
    ]);
    expect(r).toMatchObject({ planted: 2, hit: ['P'], missed: ['N'], total: 4, unmatched: 1 });
    expect(r.falseAlarms.map(x => x.trapId)).toEqual(['T', 'T']);
  });

  it('does not count a planted hit as a false alarm even if it also touches a trap', () => {
    const r = scoreFindings(fx, [f({ text: 'Power analysis omits Aim 3.', sectionTitle: 'Rigor' })]);
    expect(r.hit).toEqual(['P']);
    expect(r.falseAlarms).toEqual([]);
  });

  it('assigns one finding to one expectation, preferring the matching checkId', () => {
    const a: Expectation = { id: 'A', checkId: 'm-rig-tests', sectionTitles: ['Results'], quoteHints: ['x one'], keywords: /test/i, note: '' };
    const b: Expectation = { id: 'B', checkId: 'm-rig-variability', sectionTitles: ['Results'], quoteHints: ['x two'], keywords: /test|sd/i, note: '' };
    const two: ReviewFixture = { id: 't', docType: 'manuscript', sections: [], planted: [a, b], traps: [] };
    const finding = f({ checkId: 'm-rig-variability', sectionTitle: 'Results', text: 'No SD and no test.' });
    expect(assign(two, finding)?.expectation.id).toBe('B');
    expect(scoreFindings(two, [finding]).hit).toEqual(['B']);
  });

  it('prefers a planted location match over a trap quote match', () => {
    const finding = f({ checkId: 'g-rig-power', sectionTitle: 'Rigor', quote: 'n = 12 mice per group gives 80% power', text: 'Powered for Aims 1 and 2 only; Aim 3 is not justified.' });
    expect(assign(fx, finding)).toMatchObject({ kind: 'planted', expectation: { id: 'P' } });
  });
});

describe('assign tiers with the real grant fixture', () => {
  it('lets the checkId outrank a keyword-only quote match', () => {
    const finding = f({
      checkId: 'g-rig-stats', sectionTitle: AIM3,
      quote: 'Mice will undergo TAC and, four weeks later, receive the kinase inhibitor or vehicle for four weeks, using eight mice per group.',
      text: 'No statistical test is named for this comparison with this sample size.',
    });
    expect(assign(GRANT_FIXTURE, finding)).toMatchObject({ kind: 'planted', expectation: { id: 'P11-stats-aim3' } });
  });

  it('a checkId-equal location match outranks a keyword-only quote match', () => {
    const a: Expectation = { id: 'A', checkId: 'c-a', sectionTitles: ['S'], keywords: /zzz/i, note: '' };
    const b: Expectation = { id: 'B', checkId: 'c-b', sectionTitles: ['S'], quoteHints: ['alpha beta gamma delta epsilon'], keywords: /topic/i, note: '' };
    const t: ReviewFixture = { id: 't', docType: 'grant', sections: [], planted: [b, a], traps: [] };
    const finding = f({ checkId: 'c-a', sectionTitle: 'S', quote: 'alpha beta gamma delta epsilon', text: 'topic' });
    expect(assign(t, finding)?.expectation.id).toBe('A');
  });
});

describe('scoreBySource', () => {
  it('counts total findings, planted hits and trap false alarms per source', () => {
    const r = scoreBySource(fx, [
      f({ source: 'editor', text: 'unrelated' }),
      f({ source: 'statistician', checkId: 'g-rig-power', quote: 'using eight mice per group' }),
      f({ source: 'statistician', checkId: 'g-rig-power', quote: 'n = 12 mice per group gives 80% power' }),
      f({ source: 'editor', text: 'Power analysis omits Aim 3.', sectionTitle: 'Rigor' }),
    ]);
    expect(r).toEqual({
      editor: { total: 2, hits: 1, falseAlarms: 0 },
      statistician: { total: 2, hits: 1, falseAlarms: 1 },
    });
  });
});

describe('scoreProse', () => {
  it('counts a planted weakness mentioned with its section label or quote', () => {
    const r = scoreProse(fx, 'Aim 3 lacks a power calculation.\nThe approach is otherwise sound.');
    expect(r.mentioned).toEqual(['P']);
    expect(r.missed).toEqual(['N']);
  });
});

describe('legacy adapter', () => {
  const sections = [{ title: 'Aim 2', text: 'Mice will undergo TAC.' }, { title: 'Aim 3', text: 'We are using eight mice per group.' }];

  it('prefers an exact section over an earlier fuzzy one', () => {
    const near = [
      { title: 'A', text: 'Aim 2 will use the knock-in lines generated in Aim 1 today.' },
      { title: 'B', text: 'Aim 3 will use the knock-in lines generated in Aim 1 today.' },
    ];
    expect(sectionTitleForQuote(near, 'Aim 3 will use the knock-in lines generated in Aim 1')).toBe('B');
  });

  it('finds the section that contains a quote', () => {
    expect(sectionTitleForQuote(sections, 'using eight mice per group')).toBe('Aim 3');
    expect(sectionTitleForQuote(sections, 'not anywhere')).toBeUndefined();
  });

  it('turns suggestions into normalized findings', () => {
    const s = { id: '1', agent: 'statistician', originalText: 'using eight mice per group', suggestedText: '', explanation: 'No power analysis.', recommendation: 'Add one.', startIndex: 0, endIndex: 0, kind: 'advisory' } as Suggestion;
    expect(fromSuggestions([s], sections)).toEqual([
      { quote: 'using eight mice per group', sectionTitle: 'Aim 3', text: 'No power analysis. Add one.', source: 'statistician' },
    ]);
  });
});

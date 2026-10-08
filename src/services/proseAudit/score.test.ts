import { describe, it, expect } from 'vitest';
import { auditText } from './metrics';
import { buildProfile, activeSummary, GENERIC_HUMAN_SUMMARY, MACHINE_REFERENCE, MIN_PROFILE_WORDS } from './profile';
import { styleDistance, WEIGHTS } from './score';
import type { MetricDeviation } from './score';
import { PATTERN_NAMES } from './patterns';
import type { AuditSummary } from '../../types';

// 15-word sentences. The word after each period is capitalized because splitSentences
// (correctly) does not treat a period followed by a lowercase word as a boundary.
const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i % 50}`)
    .join(' ')
    .replace(/((?:\S+\s+){14}\S+)\s+(\S)/g, (_, run: string, next: string) => `${run}. ${next.toUpperCase()}`);

describe('buildProfile', () => {
  it('measures the samples and keeps example sentences', () => {
    const sample = 'We purified the complex by gel filtration. Binding fell at low pH in every replicate. ' + words(2100);
    const { profile, warning } = buildProfile('My grants', [sample]);
    expect(profile.name).toBe('My grants');
    expect(profile.sampleWords).toBeGreaterThan(MIN_PROFILE_WORDS);
    expect(profile.summary.sentences).toBeGreaterThan(10);
    expect(profile.exampleSentences.length).toBeGreaterThan(0);
    expect(profile.exampleSentences.length).toBeLessThanOrEqual(8);
    expect(warning).toBeUndefined();
  });

  it('warns below the recommended sample size and rejects a tiny one', () => {
    const { warning } = buildProfile('Short', [words(1700)]);
    expect(warning).toMatch(/2,?000/);
    expect(() => buildProfile('Tiny', ['One short sentence of prose here.'])).toThrow(/1,?500/);
  });

  it('merges several samples', () => {
    const p = buildProfile('Merged', [words(900), words(900)]).profile;
    expect(p.sampleWords).toBeGreaterThan(MIN_PROFILE_WORDS);
  });
});

describe('buildProfile examples and boundaries', () => {
  it('chooses tell-free examples within a sensible band of the mean', () => {
    const clean = 'Binding fell at low pH in every replicate we measured here. ';
    const long = 'We purified the complex and then measured binding across a very wide range of conditions at several temperatures in buffers of varying ionic strength over many hours. ';
    const tells = 'Binding fell at low pH; the effect was larger, which is notable, rather than small. ';
    const sample = (clean.repeat(60) + long.repeat(20) + tells.repeat(20)).repeat(2) + words(1500);
    const { profile } = buildProfile('Mixed', [sample]);
    const mean = profile.summary.meanWords;
    expect(profile.exampleSentences.length).toBeGreaterThan(0);
    for (const ex of profile.exampleSentences) {
      const a = auditText(ex);
      expect(a.sentences).toHaveLength(1);
      expect(a.sentences[0].tells).toEqual([]);
      expect(a.sentences[0].words).toBeGreaterThanOrEqual(10);
      expect(a.sentences[0].words).toBeLessThanOrEqual(28);
      expect(Math.abs(a.sentences[0].words - mean)).toBeLessThanOrEqual(10);
      expect(ex).not.toMatch(/;|rather than|which is/);
    }
  });

  it('accepts exactly 1,500 words (with a warning) and rejects 1,499', () => {
    const ok = buildProfile('Edge', [words(1500)]);
    expect(ok.profile.sampleWords).toBe(1500);
    expect(ok.warning).toMatch(/2,?000/);
    expect(() => buildProfile('Edge', [words(1499)])).toThrow(/1,?500/);
  });

  it('warns at 1,999 words and not at exactly 2,000', () => {
    expect(buildProfile('Edge', [words(1999)]).warning).toBeDefined();
    const at = buildProfile('Edge', [words(2000)]);
    expect(at.profile.sampleWords).toBe(2000);
    expect(at.warning).toBeUndefined();
  });
});

describe('activeSummary', () => {
  it('falls back to the labeled generic baseline', () => {
    const a = activeSummary(undefined);
    expect(a.isGeneric).toBe(true);
    expect(a.summary).toBe(GENERIC_HUMAN_SUMMARY);
  });

  it('prefers a real profile', () => {
    const profile = buildProfile('Mine', [words(1600)]).profile;
    expect(activeSummary(profile)).toEqual({ summary: profile.summary, isGeneric: false });
  });
});

describe('styleDistance', () => {
  it('scores the voice profile itself as close to zero', () => {
    const r = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    expect(r.score).toBe(0);
    expect(r.band).toBe('close');
  });

  it('scores the machine reference as far', () => {
    const r = styleDistance(MACHINE_REFERENCE, GENERIC_HUMAN_SUMMARY);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.band).toBe('far');
  });

  it('never returns NaN when a voice metric is zero', () => {
    const voice = { ...GENERIC_HUMAN_SUMMARY, meanWords: 0, counts: {}, rates: {} };
    const r = styleDistance(MACHINE_REFERENCE, voice as typeof GENERIC_HUMAN_SUMMARY);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('never returns NaN for a stored profile with a missing metric', () => {
    const voice = { ...GENERIC_HUMAN_SUMMARY, meanWords: undefined as unknown as number };
    const r = styleDistance(MACHINE_REFERENCE, voice);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.deviations.every(d => Number.isFinite(d.deviation) && Number.isFinite(d.voice))).toBe(true);
    const noRates = { ...GENERIC_HUMAN_SUMMARY, rates: undefined } as unknown as AuditSummary;
    expect(Number.isFinite(styleDistance(MACHINE_REFERENCE, noRates).score)).toBe(true);
  });

  it('reports a row for every metric', () => {
    const r = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    expect(r.deviations.map(d => d.metric).sort()).toEqual(Object.keys(WEIGHTS).sort());
  });

  const NINE = [
    'not X but/instead', 'instead of', 'This/That anaphora', 'throat-clearing', 'em dash',
    'not only but also', 'paragraph connective', 'summary flourish', 'stock vocabulary',
  ];
  const withRates = (base: AuditSummary, rates: Record<string, number>): AuditSummary => ({
    ...base,
    rates: { ...base.rates, ...rates },
  });

  it.each(NINE)('score is monotone in the draft rate of %s', metric => {
    const scores = [0, 0.1, 1, 5].map(r =>
      styleDistance(withRates(GENERIC_HUMAN_SUMMARY, { [metric]: r }), GENERIC_HUMAN_SUMMARY).score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    expect(scores[3]).toBeGreaterThan(scores[0]);
  });

  it('a trace of every unreferenced tell never lowers the score', () => {
    // A draft that is machine-like on the seven calibrated metrics (plus tricolon) only.
    // It should land firmly in the far band but NOT near 90: the nine untabulated tells
    // are real dimensions of style, so a draft that shows none of them is not fully
    // machine-like. The point of the test is monotonicity: adding a trace of each tell
    // must not reduce the score.
    const sevenOnly = withRates(MACHINE_REFERENCE, Object.fromEntries(NINE.map(m => [m, 0])));
    const traces = withRates(sevenOnly, Object.fromEntries(NINE.map(m => [m, 0.1])));
    const without = styleDistance(sevenOnly, GENERIC_HUMAN_SUMMARY).score;
    const withTraces = styleDistance(traces, GENERIC_HUMAN_SUMMARY).score;
    expect(withTraces).toBeGreaterThanOrEqual(without);
    expect(without).toBeGreaterThanOrEqual(60);
  });

  it('weights the untabulated tells below the calibrated ones', () => {
    const sum = (keys: string[]) => keys.reduce((a, k) => a + WEIGHTS[k], 0);
    const calibrated = Object.keys(WEIGHTS).filter(k => !NINE.includes(k));
    expect(Object.keys(WEIGHTS).length).toBe(calibrated.length + NINE.length);
    expect(sum(NINE)).toBeLessThan(sum(calibrated));
    for (const k of NINE) expect(WEIGHTS[k]).toBe(0.5);
  });

  describe('when the author voice sits near the machine reference', () => {
    const withSemis = (n: number): AuditSummary => ({
      ...GENERIC_HUMAN_SUMMARY,
      rates: { ...GENERIC_HUMAN_SUMMARY.rates, semicolon: n },
    });
    const semi = (r: ReturnType<typeof styleDistance>) => r.deviations.find(d => d.metric === 'semicolon')!;

    it('does not saturate on one extra semicolon', () => {
      const r = styleDistance(withSemis(22), withSemis(20));
      expect(semi(r).deviation).toBeLessThan(1);
      expect(semi(r).deviation).toBeGreaterThan(0);
    });

    it('changes smoothly as the voice value crosses the machine value', () => {
      const devs = [19, 20, 21].map(v => semi(styleDistance(withSemis(22), withSemis(v))).deviation);
      expect(devs[0]).toBeGreaterThan(devs[1]);
      expect(devs[1]).toBeGreaterThan(devs[2]);
      expect(devs[0] - devs[1]).toBeLessThan(0.3);
      expect(devs[1] - devs[2]).toBeLessThan(0.3);
    });
  });

  it('does not penalize drift below the voice', () => {
    const terse: AuditSummary = { ...GENERIC_HUMAN_SUMMARY, meanWords: 8 };
    expect(styleDistance(terse, GENERIC_HUMAN_SUMMARY).score).toBe(0);
  });

  it('only weights metrics that exist', () => {
    const special = ['meanWords', 'pctOver35'];
    for (const key of Object.keys(WEIGHTS)) {
      if (!special.includes(key)) expect(PATTERN_NAMES).toContain(key);
    }
  });

  it('rises when semicolons or long sentences are added', () => {
    const plain = auditText('We purified the complex by gel filtration in three independent runs. Binding fell at low pH. The structure was solved at three angstrom resolution.').summary;
    const tells = auditText('We purified the complex by gel filtration; binding fell at low pH, which is the quantity that matters, rather than the affinity we measured before in the previous study of this system.').summary;
    const base = styleDistance(plain, GENERIC_HUMAN_SUMMARY).score;
    expect(styleDistance(tells, GENERIC_HUMAN_SUMMARY).score).toBeGreaterThan(base);
  });

});

describe('scoring constants (final review)', () => {
  const sem = (n: number): AuditSummary => ({ ...GENERIC_HUMAN_SUMMARY, rates: { ...GENERIC_HUMAN_SUMMARY.rates, semicolon: n } });
  const dev = (r: ReturnType<typeof styleDistance>, m: string): MetricDeviation => r.deviations.find(d => d.metric === m)!;
  const lerp = (f: number): AuditSummary => {
    const rates: Record<string, number> = {};
    for (const k of Object.keys(MACHINE_REFERENCE.rates)) rates[k] = GENERIC_HUMAN_SUMMARY.rates[k] + f * (MACHINE_REFERENCE.rates[k] - GENERIC_HUMAN_SUMMARY.rates[k]);
    return { ...GENERIC_HUMAN_SUMMARY, meanWords: 17.6 + f * (26.8 - 17.6), pctOver35: 1 + f * 26, rates };
  };

  it('pins the weights', () => {
    expect(WEIGHTS).toEqual({
      meanWords: 2, pctOver35: 2, 'rather than': 2, semicolon: 1.5, 'which is appositive': 1.5, 'is what cleft': 1.5, 'initial Because': 1,
      'not X but/instead': 0.5, 'instead of': 0.5, 'This/That anaphora': 0.5, 'throat-clearing': 0.5, 'em dash': 0.5,
      'not only but also': 0.5, 'paragraph connective': 0.5, 'summary flourish': 0.5, 'stock vocabulary': 0.5,
    });
  });

  it('does not score tricolon: the author\'s own prose saturates it', () => {
    expect(WEIGHTS).not.toHaveProperty('tricolon');
    const base = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    const heavy = styleDistance({ ...GENERIC_HUMAN_SUMMARY, rates: { ...GENERIC_HUMAN_SUMMARY.rates, tricolon: 40 } }, GENERIC_HUMAN_SUMMARY);
    expect(heavy.score).toBe(base.score);
    expect(heavy.deviations.map(d => d.metric)).not.toContain('tricolon');
  });

  it('clamps one metric\'s drift at 1.5 (neither removed nor widened)', () => {
    expect(dev(styleDistance(sem(1000), sem(0)), 'semicolon').deviation).toBe(1.5);
    expect(dev(styleDistance(sem(21 * 1.5), sem(0)), 'semicolon').deviation).toBe(1.5);
    expect(dev(styleDistance(sem(21 * 1.2), sem(0)), 'semicolon').deviation).toBe(1.2);
  });

  it('keeps a floor under the scale when the voice sits at the machine value (9 words for mean length, 26 for >35, 5 otherwise)', () => {
    const atMachine = (over: Partial<AuditSummary>): AuditSummary => ({ ...MACHINE_REFERENCE, ...over });
    expect(dev(styleDistance(atMachine({ meanWords: 26.8 + 4.5 }), MACHINE_REFERENCE), 'meanWords').deviation).toBe(0.5);
    expect(dev(styleDistance(atMachine({ pctOver35: 27 + 13 }), MACHINE_REFERENCE), 'pctOver35').deviation).toBe(0.5);
    const r = { ...MACHINE_REFERENCE.rates, semicolon: 21 + 2.5 };
    expect(dev(styleDistance({ ...MACHINE_REFERENCE, rates: r }, MACHINE_REFERENCE), 'semicolon').deviation).toBe(0.5);
  });

  it('caps the score at 100 even when every metric overshoots', () => {
    const huge: AuditSummary = { ...MACHINE_REFERENCE, meanWords: 200, pctOver35: 100, rates: Object.fromEntries(Object.keys(MACHINE_REFERENCE.rates).map(k => [k, 1000])) };
    expect(styleDistance(huge, GENERIC_HUMAN_SUMMARY).score).toBe(100);
    // at 1.5 per metric the unclamped value would be 150
  });

  it('puts the band boundaries at 25 and 50 exactly', () => {
    const seen = new Map<number, string>();
    for (let i = 0; i <= 300; i++) {
      const r = styleDistance(lerp(i / 300), GENERIC_HUMAN_SUMMARY);
      seen.set(r.score, r.band);
    }
    expect(seen.get(24)).toBe('close');
    expect(seen.get(25)).toBe('drifting');
    expect(seen.get(50)).toBe('drifting');
    expect(seen.get(51)).toBe('far');
  });

  it('sorts deviations worst first even when the worst metric is listed last', () => {
    // meanWords (listed first) is at the voice; the heaviest drift is in a later metric.
    const draft: AuditSummary = { ...GENERIC_HUMAN_SUMMARY, rates: { ...GENERIC_HUMAN_SUMMARY.rates, 'stock vocabulary': 5, semicolon: 10, 'rather than': 25 } };
    const devs = styleDistance(draft, GENERIC_HUMAN_SUMMARY).deviations.map(d => d.deviation);
    expect(devs).toEqual([...devs].sort((a, b) => b - a));
    expect(devs[0]).toBeGreaterThan(devs[devs.length - 1]);
  });
});

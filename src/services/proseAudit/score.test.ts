import { describe, it, expect } from 'vitest';
import { auditText } from './metrics';
import { buildProfile, activeSummary, GENERIC_HUMAN_SUMMARY, MACHINE_REFERENCE, MIN_PROFILE_WORDS } from './profile';
import { styleDistance, WEIGHTS } from './score';
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

  it('still reports a row for every metric but scores only informative ones', () => {
    const r = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    expect(r.deviations.map(d => d.metric).sort()).toEqual(Object.keys(WEIGHTS).sort());
  });

  it('a tell the references never mention still raises the score', () => {
    const withDashes: AuditSummary = {
      ...GENERIC_HUMAN_SUMMARY,
      rates: { ...GENERIC_HUMAN_SUMMARY.rates, 'em dash': 15 },
    };
    const base = styleDistance(GENERIC_HUMAN_SUMMARY, GENERIC_HUMAN_SUMMARY);
    const r = styleDistance(withDashes, GENERIC_HUMAN_SUMMARY);
    expect(base.score).toBe(0);
    expect(r.score).toBeGreaterThan(0);
    expect(r.deviations[0].metric).toBe('em dash');
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

  it('reports per-metric deviations sorted worst first', () => {
    const r = styleDistance(MACHINE_REFERENCE, GENERIC_HUMAN_SUMMARY);
    expect(r.deviations.length).toBeGreaterThan(3);
    expect(r.deviations[0].deviation).toBeGreaterThanOrEqual(r.deviations[1].deviation);
    expect(r.deviations[0]).toHaveProperty('label');
  });
});

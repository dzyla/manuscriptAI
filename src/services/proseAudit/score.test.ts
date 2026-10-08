import { describe, it, expect } from 'vitest';
import { auditText } from './metrics';
import { buildProfile, activeSummary, GENERIC_HUMAN_SUMMARY, MACHINE_REFERENCE, MIN_PROFILE_WORDS } from './profile';
import { styleDistance } from './score';

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
    expect(r.score).toBeGreaterThan(50);
    expect(r.band).toBe('far');
  });

  it('never returns NaN when a voice metric is zero', () => {
    const voice = { ...GENERIC_HUMAN_SUMMARY, meanWords: 0, counts: {}, rates: {} };
    const r = styleDistance(MACHINE_REFERENCE, voice as typeof GENERIC_HUMAN_SUMMARY);
    expect(Number.isFinite(r.score)).toBe(true);
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

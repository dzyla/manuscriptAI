import { auditText } from './metrics';
import type { AuditSummary, VoiceProfile } from '../../types';
import { PATTERN_NAMES } from './patterns';

export const MIN_PROFILE_WORDS = 1500;
export const RECOMMENDED_PROFILE_WORDS = 2000;

function summaryFrom(partial: Partial<AuditSummary> & { rates: Record<string, number> }): AuditSummary {
  const rates: Record<string, number> = {};
  for (const name of PATTERN_NAMES) rates[name] = partial.rates[name] ?? 0;
  return {
    sentences: partial.sentences ?? 0,
    meanWords: partial.meanWords ?? 0,
    pctOver35: partial.pctOver35 ?? 0,
    lengthCv: partial.lengthCv ?? 0,
    counts: {},
    rates,
  };
}

/**
 * Fallback target when the author has no profile yet: the human column of the
 * human-prose-audit skill's calibration (one scientist's unassisted draft).
 */
export const GENERIC_HUMAN_SUMMARY: AuditSummary = summaryFrom({
  meanWords: 17.6,
  pctOver35: 1,
  lengthCv: 0.5,
  rates: { 'rather than': 2.9, semicolon: 0, 'which is appositive': 0, 'is what cleft': 0, 'initial Because': 0, tricolon: 4.4 },
});

/** The LLM-assisted column of the same calibration: the far end of the scale. */
export const MACHINE_REFERENCE: AuditSummary = summaryFrom({
  meanWords: 26.8,
  pctOver35: 27,
  lengthCv: 0.3,
  rates: { 'rather than': 25.2, semicolon: 21, 'which is appositive': 7, 'is what cleft': 4, 'initial Because': 4, tricolon: 12 },
});

export function buildProfile(name: string, samples: string[]): { profile: VoiceProfile; warning?: string } {
  const text = samples.join('\n\n');
  const metrics = auditText(text);
  const sampleWords = metrics.sentences.reduce((a, s) => a + s.words, 0);
  if (sampleWords < MIN_PROFILE_WORDS) {
    throw new Error(`Need at least ${MIN_PROFILE_WORDS.toLocaleString()} words of your own writing; got ${sampleWords.toLocaleString()}.`);
  }
  const clean = metrics.sentences
    .filter(s => s.tells.length === 0 && s.words >= 10 && s.words <= 28)
    .sort((a, b) => Math.abs(a.words - metrics.summary.meanWords) - Math.abs(b.words - metrics.summary.meanWords))
    .slice(0, 8)
    .map(s => text.slice(s.start, s.end));
  return {
    profile: {
      id: `vp_${Date.now().toString(36)}`,
      name,
      createdAt: Date.now(),
      sampleWords,
      summary: metrics.summary,
      exampleSentences: clean,
    },
    warning: sampleWords < RECOMMENDED_PROFILE_WORDS
      ? `Only ${sampleWords.toLocaleString()} words measured. ${RECOMMENDED_PROFILE_WORDS.toLocaleString()} or more gives a steadier profile.`
      : undefined,
  };
}

export function activeSummary(p?: VoiceProfile): { summary: AuditSummary; isGeneric: boolean } {
  return p ? { summary: p.summary, isGeneric: false } : { summary: GENERIC_HUMAN_SUMMARY, isGeneric: true };
}

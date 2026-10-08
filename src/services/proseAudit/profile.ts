import { auditText } from './metrics';
import type { AuditSummary, VoiceProfile } from '../../types';
import { PATTERN_NAMES } from './patterns';

export const MIN_PROFILE_WORDS = 1500;
export const RECOMMENDED_PROFILE_WORDS = 2000;

/**
 * Builds a reference AuditSummary from the handful of values we actually have.
 *
 * Every pattern NOT listed in `rates` defaults to 0. Those zeros mean "not
 * tabulated / effectively absent in that reference text", not "measured as zero".
 * The human side leaves the nine additional tells at 0; the machine side gives them
 * the chosen threshold below so a fully machine-style draft can approach 100.
 *
 * `lengthCv` is deliberately NOT a reference value (always 0 here). Its direction is
 * inverted relative to the other tells (machine prose is more uniform, so a LOWER
 * CV), and the machine-side figure was only an estimate. It stays measured in every
 * real AuditSummary and is shown as an informational row, never scored.
 */
function summaryFrom(partial: { meanWords: number; pctOver35: number; rates: Record<string, number> }): AuditSummary {
  const rates: Record<string, number> = {};
  for (const name of PATTERN_NAMES) rates[name] = partial.rates[name] ?? 0;
  return {
    sentences: 0,
    meanWords: partial.meanWords,
    pctOver35: partial.pctOver35,
    lengthCv: 0,
    counts: {},
    rates,
  };
}

/*
 * Provenance of every reference constant (rates are occurrences per 100 sentences).
 *
 * From the human-prose-audit skill's calibration table (the author's unassisted
 * draft vs an LLM-assisted revision of the same document): meanWords, pctOver35,
 * 'rather than', semicolon, 'which is appositive', 'is what cleft', 'initial Because'.
 *
 * Measured from the user's own 2020-22 grant corpus (16.7k words, 787 sentences):
 * human 'tricolon' 4.4.
 *
 * Estimate, not measured: machine-side 'tricolon' 12. It is NOT scored: the author's own unassisted R01 prose measures
 * 11.1 per 100, almost the whole scale, so the metric cannot tell the author from the machine. It is shown as information.
 *
 * Chosen thresholds, not measured: machine-side 5 for 'not X but/instead', 'instead of',
 * 'This/That anaphora', 'throat-clearing', 'em dash', 'not only but also',
 * 'paragraph connective', 'summary flourish' and 'stock vocabulary'. 5 occurrences per
 * 100 sentences is treated as fully machine-like for that tell; it equals the default
 * span, and it is replaced in effect once the author builds a real voice profile. Neither
 * the skill's table nor any corpus supplied these.
 */

/**
 * Fallback target when the author has no profile yet: the human column of the
 * calibration (one scientist's unassisted draft) plus the corpus-measured tricolon rate.
 */
export const GENERIC_HUMAN_SUMMARY: AuditSummary = summaryFrom({
  meanWords: 17.6,
  pctOver35: 1,
  rates: { 'rather than': 2.9, semicolon: 0, 'which is appositive': 0, 'is what cleft': 0, 'initial Because': 0, tricolon: 4.4 },
});

/** The LLM-assisted column of the same calibration: the far end of the scale (machine tricolon is an estimate). */
export const MACHINE_REFERENCE: AuditSummary = summaryFrom({
  meanWords: 26.8,
  pctOver35: 27,
  rates: {
    'rather than': 25.2, semicolon: 21, 'which is appositive': 7, 'is what cleft': 4, 'initial Because': 4, tricolon: 12,
    'not X but/instead': 5, 'instead of': 5, 'This/That anaphora': 5, 'throat-clearing': 5, 'em dash': 5,
    'not only but also': 5, 'paragraph connective': 5, 'summary flourish': 5, 'stock vocabulary': 5,
  },
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

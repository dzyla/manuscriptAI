import { describe, it, expect } from 'vitest';
import { detectorSuggestions, splitSentences } from './detectors';

/** Every advisory a detector produces must quote text that literally exists. */
function assertQuotesAnchor(text: string) {
  const sugs = detectorSuggestions(text);
  for (const s of sugs) {
    expect(text).toContain(s.originalText);
    expect(text.slice(s.startIndex, s.endIndex)).toBe(s.originalText);
    expect(s.kind).toBe('advisory');
    expect(s.suggestedText).toBe('');
    expect(s.recommendation.length).toBeGreaterThan(0);
  }
  return sugs;
}

describe('splitSentences', () => {
  it('returns absolute offsets that slice back to the sentence', () => {
    const text = 'First sentence. Second one here! Third?';
    for (const s of splitSentences(text)) {
      expect(text.slice(s.start, s.start + s.text.length)).toBe(s.text);
    }
  });
});

describe('detectPValueNoTest', () => {
  it('flags a p-value with no named test', () => {
    const text = 'The treatment group improved (p < 0.01) over eight weeks.';
    const sugs = assertQuotesAnchor(text);
    expect(sugs.some(s => s.category === 'statistics' && s.agent === 'statistician')).toBe(true);
  });
  it('does NOT flag a p-value that names its test', () => {
    const text = 'A two-sample t-test showed improvement (p < 0.01).';
    expect(detectorSuggestions(text).some(s => /p-value/.test(s.explanation))).toBe(false);
  });
});

describe('detectSignificantNoStat', () => {
  it('flags an unsupported significance claim', () => {
    const text = 'There was a significant increase in tumor volume between groups.';
    const sugs = assertQuotesAnchor(text);
    expect(sugs.some(s => s.explanation.includes('Significant'))).toBe(true);
  });
  it('ignores "significant" backed by a p-value', () => {
    const text = 'There was a significant increase (p = 0.02) in tumor volume.';
    expect(detectorSuggestions(text).some(s => s.explanation.includes('Significant'))).toBe(false);
  });
});

describe('detectMeanWithoutSpread', () => {
  it('flags x ± y with no SD/SEM label', () => {
    const text = 'The mean latency was 4.2 ± 0.3 across all trials.';
    const sugs = assertQuotesAnchor(text);
    expect(sugs.some(s => /SD or SEM/.test(s.recommendation))).toBe(true);
  });
  it('ignores a ± value that states SD', () => {
    const text = 'The mean latency was 4.2 ± 0.3 (SD).';
    expect(detectorSuggestions(text).some(s => /SD or SEM/.test(s.recommendation))).toBe(false);
  });
});

describe('detectUncitedClaim', () => {
  it('flags an uncited appeal to prior work', () => {
    const text = 'Previous studies have shown that this pathway drives resistance.';
    const sugs = assertQuotesAnchor(text);
    expect(sugs.some(s => s.category === 'citation')).toBe(true);
  });
  it('ignores the same claim when a citation is present', () => {
    const text = 'Previous studies have shown that this pathway drives resistance [4].';
    expect(detectorSuggestions(text).some(s => s.category === 'citation')).toBe(false);
  });
});

describe('detectSampleSizeMismatch', () => {
  it('flags conflicting total sample sizes across the manuscript', () => {
    const text = 'We enrolled N = 42 participants. ... In the analysis, N = 45 were included.';
    const sugs = assertQuotesAnchor(text);
    const mism = sugs.filter(s => s.agent === 'consistency' && /sample size/.test(s.explanation));
    expect(mism.length).toBeGreaterThanOrEqual(2);
  });
  it('does not flag a single consistent N', () => {
    const text = 'We enrolled N = 42 participants and analyzed all N = 42.';
    expect(detectorSuggestions(text).some(s => /sample size/.test(s.explanation))).toBe(false);
  });
});

describe('detectUndefinedAbbreviation', () => {
  it('flags an acronym used before definition', () => {
    const text = 'The QTL was mapped across three chromosomes in this cohort.';
    const sugs = assertQuotesAnchor(text);
    expect(sugs.some(s => s.originalText === 'QTL')).toBe(true);
  });
  it('ignores a defined acronym and common ones', () => {
    const text = 'Quantitative trait locus (QTL) analysis used DNA from each sample.';
    const sugs = detectorSuggestions(text);
    expect(sugs.some(s => s.originalText === 'QTL')).toBe(false);
    expect(sugs.some(s => s.originalText === 'DNA')).toBe(false);
  });
});

describe('detectorSuggestions integration', () => {
  it('never fabricates numbers absent from the source', () => {
    const text = 'The effect was significant. Values were 4.2 ± 0.3 in the treated group.';
    for (const s of detectorSuggestions(text)) {
      const invented = (s.recommendation.match(/\d+(\.\d+)?/g) || [])
        .filter(n => !text.includes(n));
      expect(invented).toEqual([]);
    }
  });
});

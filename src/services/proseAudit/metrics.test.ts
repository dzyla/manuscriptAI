import { describe, it, expect } from 'vitest';
import { auditText, worstSentences } from './metrics';
import { KERNEL_PATTERN_NAMES } from './patterns';
import { readFileSync } from 'node:fs';

// Read rather than import: tsconfig has no resolveJsonModule.
const parity = JSON.parse(
  readFileSync(new URL('../../test/fixtures/proseAudit/kernelParity.json', import.meta.url), 'utf8'),
) as { text: string; metrics: Record<string, number> };

const audit = (t: string) => auditText(t);

describe('kernel parity', () => {
  it('reproduces the kernel sentence count and length metrics', () => {
    const m = audit(parity.text).summary;
    expect(m.sentences).toBe(parity.metrics.sentences);
    // The kernel does not exclude headings: it glues each one onto the sentence that
    // follows, so its word counts include the four heading words (Introduction,
    // Methods, Results, Discussion). The audit drops headings on purpose; compare
    // total words with that known offset, to within the kernel's 1-decimal rounding.
    const KERNEL_HEADING_WORDS = 4;
    const auditWords = m.meanWords * m.sentences + KERNEL_HEADING_WORDS;
    const kernelWords = parity.metrics.mean_sentence_words * parity.metrics.sentences;
    expect(Math.abs(auditWords - kernelWords)).toBeLessThan(1);
    expect(m.pctOver35).toBeCloseTo(parity.metrics.pct_over_35_words, 1);
  });

  it('reproduces every kernel pattern count', () => {
    const m = audit(parity.text).summary;
    for (const name of KERNEL_PATTERN_NAMES) {
      expect(m.counts[name], name).toBe(parity.metrics[name]);
    }
  });
});

describe('tell patterns', () => {
  const hits = (t: string) => audit(t).summary.counts;

  it('flags a contrastive definition', () => {
    expect(hits('The state is selected kinetically rather than thermodynamically here.')['rather than']).toBe(1);
  });

  it('flags a semicolon, a cleft and an appositive', () => {
    const c = hits('The barrier is high; the state persists for hours in this assay.');
    expect(c.semicolon).toBe(1);
    expect(hits('Converting persistence into a barrier is what makes this quantitative.')['is what cleft']).toBe(1);
    expect(hits('We measured the dwell time, which is the quantity that matters most.')['which is appositive']).toBe(1);
  });

  it('flags throat-clearing, em dashes and stock vocabulary', () => {
    const c = hits('Notably, we delve into the pivotal landscape of receptor binding — at length.');
    expect(c['throat-clearing']).toBe(1);
    expect(c['em dash']).toBe(1);
    expect(c['stock vocabulary']).toBeGreaterThanOrEqual(3);
  });

  it('does not flag ordinary scientific prose', () => {
    const c = hits('However, binding was reduced at pH 5.5. The complex was purified by gel filtration. Values are means of three experiments.');
    for (const [k, v] of Object.entries(c)) expect(v, k).toBe(0);
  });

  it('keeps decimals and p-values inside one sentence', () => {
    const m = audit('Binding fell at pH 5.5 (p < 0.01) in every replicate of the assay.');
    expect(m.summary.sentences).toBe(1);
  });
});

describe('sentence filtering', () => {
  it('excludes headings and short fragments', () => {
    const m = audit('Specific Aims\n\nWe will determine how the envelope protein drives fusion of membranes.\n\nAim 1\n');
    expect(m.summary.sentences).toBe(1);
  });

  it('stops counting at a reference list', () => {
    const text = [
      'The receptor binds the envelope protein with nanomolar affinity in our assay.',
      '',
      'References',
      '',
      '1. Author A, Author B; Author C. Title of the work; Journal 2019; 12: 1-10.',
      '2. Author D; Author E. Another title; Journal 2020; 13: 11-20.',
    ].join('\n');
    const m = audit(text);
    expect(m.summary.sentences).toBe(1);
    expect(m.summary.counts.semicolon).toBe(0);
  });

  it('splits sections on headings and audits each', () => {
    const text = 'Significance\n\nThe problem matters because the virus evades antibodies in most patients.\n\nApproach\n\nWe will solve structures; we will then validate them by mutagenesis.';
    const m = audit(text);
    expect(m.sections.map(s => s.title)).toEqual(['Significance', 'Approach']);
    expect(m.sections[1].summary.counts.semicolon).toBe(1);
    expect(m.sections[0].summary.counts.semicolon).toBe(0);
  });
});

describe('worstSentences', () => {
  it('ranks by length plus eight times tell count, worst first', () => {
    const short = 'The barrier is high; it persists.';
    const long = 'We measured ' + 'the dwell time of the complex ' + 'in a single long sentence of plain prose.';
    const m = audit(`${long} ${short}`);
    const ranked = worstSentences(m, 2);
    expect(ranked[0].tells).toContain('semicolon');
    expect(ranked[0].severity).toBeGreaterThan(ranked[1].severity);
  });

  it('carries offsets that slice the original text back out', () => {
    const text = 'First sentence of the draft is here. Second sentence is longer and carries a semicolon; here it is.';
    const m = audit(text);
    const s = worstSentences(m, 1)[0];
    expect(text.slice(s.start, s.end)).toContain('semicolon');
  });
});

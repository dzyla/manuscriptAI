import { describe, it, expect } from 'vitest';
import { auditText, worstSentences, flaggedSentences, MIN_FLAG_SEVERITY, MAX_REWRITE_WORDS, REFERENCE_HEADING } from './metrics';
import { KERNEL_PATTERN_NAMES } from './patterns';
import { readFileSync } from 'node:fs';

// Read rather than import: tsconfig has no resolveJsonModule.
type Parity = { text: string; metrics: Record<string, number> };
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/proseAudit/${name}.json`, import.meta.url), 'utf8')) as Parity;

const audit = (t: string) => auditText(t);

// Both fixtures are kernel.py output on heading-free, abbreviation-free text. Parity is only
// expected there: splitSentences is decimal- and abbreviation-aware by design while the
// kernel's splitter is not, and the kernel glues headings onto the next sentence while the
// audit drops them (covered separately below).
describe.each(['kernelParity', 'kernelParityRich'])('kernel parity: %s', name => {
  const parity = load(name);

  it('reproduces the kernel sentence count and length metrics', () => {
    const m = audit(parity.text).summary;
    expect(m.sentences).toBe(parity.metrics.sentences);
    expect(m.meanWords).toBeCloseTo(parity.metrics.mean_sentence_words, 1);
    expect(m.pctOver35).toBeCloseTo(parity.metrics.pct_over_35_words, 1);
  });

  it('reproduces every kernel pattern count', () => {
    const m = audit(parity.text).summary;
    for (const pattern of KERNEL_PATTERN_NAMES) {
      expect(m.counts[pattern], pattern).toBe(parity.metrics[pattern]);
    }
  });

  it('reproduces every kernel per-100-sentence rate', () => {
    // Within one rounding step (0.1), not toBeCloseTo(.., 1): on an exact tie such as 1/16 = 6.25
    // Python round() is half-even (6.2) and Math.round is half-up (6.3).
    const m = audit(parity.text).summary;
    for (const pattern of KERNEL_PATTERN_NAMES) {
      expect(Math.abs(m.rates[pattern] - parity.metrics[`${pattern}_per100`]), pattern).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });
});

describe('kernel parity: rich fixture exercises every pattern', () => {
  const { metrics } = load('kernelParityRich');

  it('fires all ten kernel patterns, one of them three or more times', () => {
    for (const pattern of KERNEL_PATTERN_NAMES) expect(metrics[pattern], pattern).toBeGreaterThan(0);
    expect(Math.max(...KERNEL_PATTERN_NAMES.map(p => metrics[p]))).toBeGreaterThanOrEqual(3);
  });

  it('counts a sentence-initial "Rather than" / "Instead of" as zero, like the kernel', () => {
    const c = audit('Rather than pooling the data, we analysed each replicate on its own. Instead of water, we used buffer for every dilution.').summary.counts;
    expect(c['rather than']).toBe(0);
    expect(c['instead of']).toBe(0);
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
    expect(m.summary.meanWords).toBe(11); // the heading's two words are not added to the sentence
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
  it('ranks by words plus eight times the weighted tell count, worst first', () => {
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

  it('keeps offsets exact across a heading, CRLF line endings and a References cut', () => {
    const first = 'The receptor binds the envelope protein with nanomolar affinity.';
    const second = 'The complex was purified by gel filtration at low temperature.';
    const text = `Results\r\n\r\n${first} ${second}\r\n\r\nReferences\r\n\r\n1. Author A; Author B. Title of the work here; Journal 2019.\r\n`;
    const m = audit(text);
    expect(m.sentences.map(s => text.slice(s.start, s.end))).toEqual([first, second]);
    expect(m.summary.counts.semicolon).toBe(0);
  });
});

describe('bibliography headings (round: final review B1)', () => {
  const PROSE = 'We purified the complex by gel filtration in three runs. Binding fell at low pH in every replicate. The structure was solved at three angstrom resolution.';
  const LIST = 'Smith J, Jones K; Lee P. Structure of the complex; a study. J Mol Biol. 2020;12:100-110.\nBrown A; Green B. Kinetics of binding; revisited. Nature. 2019;5:1-9.';
  it.each(['References', 'References Cited', 'Bibliography and References Cited', 'REFERENCES:', '3. Bibliography', 'LITERATURE CITED:', 'Works Cited', 'B) References', 'Bibliography'])(
    'ends analysis at the heading "%s"',
    heading => {
      expect(REFERENCE_HEADING.test(heading)).toBe(true);
      const m = auditText(`Approach\n\n${PROSE}\n\n${heading}\n\n${LIST}`);
      expect(m.summary.sentences).toBe(3);
      expect(m.summary.rates.semicolon).toBe(0);
    },
  );
  it('does not treat a sentence that merely starts with the word as a heading', () => {
    expect(REFERENCE_HEADING.test('References to the earlier work are listed in Table 2')).toBe(false);
    expect(REFERENCE_HEADING.test('Literature cited here disagreed with the model')).toBe(false);
  });
});

describe('section breakdown', () => {
  const A = 'We purified the complex by gel filtration in three runs. Binding fell at low pH in every replicate. The structure was solved at three angstrom resolution.';
  const B = 'The state is selected kinetically rather than thermodynamically; the effect was large. The receptor binds the protein; affinity was nanomolar in this assay.';
  const m = auditText(`Methods\n\n${A}\n\nResults\n\n${B}`);
  it('counts each section\'s own sentences and rates, not the whole document\'s', () => {
    expect(m.sections.map(s => s.title)).toEqual(['Methods', 'Results']);
    expect(m.sections[0].summary.sentences).toBe(3);
    expect(m.sections[1].summary.sentences).toBe(2);
    expect(m.sections[0].summary.rates.semicolon).toBe(0);
    expect(m.sections[1].summary.rates.semicolon).toBe(100);
    expect(m.summary.sentences).toBe(5);
  });
  it('does not take a ruler line as a section title', () => {
    const r = auditText(`-------- 1 page limit ------\n\n${A}\n\nResults\n\n${B}`);
    expect(r.sections.map(s => s.title)).toEqual(['Results']);
  });
});

describe('flaggedSentences', () => {
  it('drops clean short sentences instead of listing them as "worst"', () => {
    const m = auditText('We purified the complex by gel filtration. Binding fell at low pH in every replicate. The structure was solved at three angstrom resolution.');
    expect(worstSentences(m, 10).length).toBe(3);
    expect(flaggedSentences(m, 10)).toEqual([]);
  });
  it('keeps sentences at or above the severity floor and lists the worst first', () => {
    const m = auditText('The state is selected kinetically rather than thermodynamically; the effect was large in all six replicates, which is clear. We purified it by gel filtration.');
    const out = flaggedSentences(m, 10);
    expect(out.length).toBe(1);
    expect(out[0].severity).toBeGreaterThanOrEqual(MIN_FLAG_SEVERITY);
  });
  it('exposes the rewrite cap used by the panel', () => {
    expect(MAX_REWRITE_WORDS).toBeGreaterThan(35);
    expect(MAX_REWRITE_WORDS).toBeLessThan(200);
  });
});

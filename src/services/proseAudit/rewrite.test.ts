import { describe, it, expect } from 'vitest';
import { buildRewritePrompt, checkRewrite, neighbourSentences } from './rewrite';

const original = 'The functional state is selected kinetically rather than thermodynamically, which is the quantity that matters; we measured 42 complexes at pH 5.5 [3].';

describe('buildRewritePrompt', () => {
  it('states the rules, the target length and the sentence', () => {
    const p = buildRewritePrompt({ sentence: original, targetWords: 18 });
    expect(p).toContain(original);
    expect(p).toMatch(/18/);
    expect(p).toMatch(/semicolon/i);
    expect(p).toMatch(/rather than/i);
    expect(p).toMatch(/number/i);
  });

  it('includes the author\'s own sentences as examples when a profile exists', () => {
    const p = buildRewritePrompt({
      sentence: original,
      targetWords: 18,
      profile: {
        id: 'v', name: 'mine', createdAt: 0, sampleWords: 2000,
        summary: { sentences: 10, meanWords: 18, pctOver35: 1, lengthCv: 0.5, counts: {}, rates: {} },
        exampleSentences: ['We purified the complex by gel filtration.'],
      },
    });
    expect(p).toContain('We purified the complex by gel filtration.');
  });

  it('gives the neighbouring sentences as context only', () => {
    const p = buildRewritePrompt({ sentence: original, before: 'Prior work disagreed.', after: 'We then validated it.', targetWords: 18 });
    expect(p).toContain('Prior work disagreed.');
    expect(p).toMatch(/context/i);
  });
});

describe('checkRewrite', () => {
  it('accepts a rewrite that keeps the numbers, the citation and drops the tells', () => {
    const r = checkRewrite(original, 'Barrier height selects the functional state. We measured 42 complexes at pH 5.5 [3].');
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a dropped number', () => {
    const r = checkRewrite(original, 'Barrier height selects the functional state. We measured complexes at pH 5.5 [3].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/42/);
  });

  it('rejects a dropped citation', () => {
    const r = checkRewrite(original, 'Barrier height selects the state. We measured 42 complexes at pH 5.5.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/\[3\]/);
  });

  it('rejects a rewrite that is no better', () => {
    const r = checkRewrite(original, 'The state is selected kinetically rather than thermodynamically; we measured 42 complexes at pH 5.5 [3].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/style/i);
  });

  it('rejects an empty or unchanged rewrite', () => {
    expect(checkRewrite(original, '   ').ok).toBe(false);
    expect(checkRewrite(original, original).ok).toBe(false);
  });

  it('treats a number written differently as preserved', () => {
    const r = checkRewrite('We saw 1,200 events in 3 runs.', 'Three runs produced 1200 events.');
    expect(r.ok).toBe(true);
  });
});

describe('checkRewrite guards (adversarial)', () => {
  const stat = 'The effect was significant (p < 0.01) at 42 nM, which is what we expected; it persisted for 2 hours [4,5].';

  it('rejects a dropped decimal and keeps a spelled-out count', () => {
    const r = checkRewrite(stat, 'The effect was significant at 42 nM. It persisted for 2 hours [4,5].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/0\.01/);
  });

  it('accepts decimals, units, spelled-out hours and the full citation group', () => {
    const r = checkRewrite(stat, 'At 42 nM the effect was significant (p < 0.01). It lasted two hours [4,5].');
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it('rejects a unit that was dropped or changed', () => {
    const r = checkRewrite(stat, 'The effect was significant (p < 0.01) at 42 mM. It lasted 2 hours [4,5].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/42nM/);
  });

  it('rejects a partly kept citation group', () => {
    const r = checkRewrite(stat, 'The effect was significant (p < 0.01) at 42 nM. It lasted 2 hours [4].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/\[4,5\]/);
  });

  it('accepts a rewrite whose only tell was a semicolon once the semicolon is gone', () => {
    const r = checkRewrite('Binding fell at low pH; the effect was large in all six replicates.', 'Binding fell at low pH. The effect was large in all six replicates.');
    expect(r.ok).toBe(true);
  });

  it('rejects a rewrite that keeps the semicolon even when it is shorter', () => {
    const r = checkRewrite('Binding fell at low pH; the effect was large in all six replicates.', 'Binding fell at low pH; the effect was large in six replicates.');
    expect(r.ok).toBe(false);
  });

  it('rejects a rewrite that is much longer than the original', () => {
    const long = 'Binding fell at low pH. The effect was large in all six replicates. We think this reflects protonation of the interface residues and perhaps a change in the conformational ensemble of the receptor under those conditions.';
    const r = checkRewrite('Binding fell at low pH; the effect was large in all six replicates.', long);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/longer/);
  });

  it('rejects a dropped gene or protein name', () => {
    const r = checkRewrite('EGFR signalling rather than TP53 loss drove the response in these cells.', 'Signalling drove the response in these cells.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/EGFR/);
    expect(r.reasons.join(' ')).toMatch(/TP53/);
  });

  it('treats whitespace-only differences as unchanged', () => {
    expect(checkRewrite(original, `  ${original.replace(' ', '  ')}\n`).ok).toBe(false);
  });
});

describe('neighbourSentences', () => {
  const plain = 'Para one ends here.\n\nLead in. Target sentence now. Follow up here. Last one.\n\nNext paragraph.';
  const s = plain.indexOf('Target');
  const e = s + 'Target sentence now.'.length;
  it('takes neighbours from the same paragraph only', () => {
    expect(neighbourSentences(plain, s, e)).toEqual({ before: 'Lead in.', after: 'Follow up here.' });
  });
  it('has no neighbours at paragraph edges', () => {
    const a = plain.indexOf('Lead in.');
    expect(neighbourSentences(plain, a, a + 8).before).toBeUndefined();
    const l = plain.indexOf('Last one.');
    expect(neighbourSentences(plain, l, l + 9).after).toBeUndefined();
  });
});

describe('ranges', () => {
  const o = 'That is normal in grant writing, but the sections all key off H1–H3 and run for 5-10 days.';
  it('rejects a range collapsed to its endpoints (found by the local-model eval: "H1–H3" came back as "H1, H3")', () => {
    const r = checkRewrite(o, 'Grant writing follows this convention. The sections rely on H1, H3 and run for 5-10 days.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/H1-H3/);
  });
  it('accepts a range kept with a different dash, or spelled "to"', () => {
    expect(checkRewrite(o, 'Grant writing follows this convention. The sections rely on H1-H3 and run for 5–10 days.').ok).toBe(true);
    expect(checkRewrite('We ran 5-10 trials in the first pass; the protocol was then fixed.', 'The first pass used 5 to 10 trials. We then fixed the protocol.').ok).toBe(true);
  });
});

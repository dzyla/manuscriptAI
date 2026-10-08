import { describe, it, expect } from 'vitest';
import { compareMarkers } from './markers';
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

describe('guards: a fact that changes must not pass (round 1)', () => {
  const bad = (o: string, r: string, re: RegExp) => {
    const c = checkRewrite(o, r);
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toMatch(re);
  };
  it('counts occurrences: "5 mice and 5 rats" -> "5 mice and rats"', () => {
    bad('We housed 5 mice and 5 rats in separate cages; both groups were fed ad libitum.', 'We housed 5 mice and rats in separate cages. Both groups were fed ad libitum.', /5 appears 2 times/);
  });
  it('catches a changed superscript exponent', () => {
    bad('We seeded 1×10⁶ cells per well; the plates were then incubated overnight.', 'We seeded 1×10⁵ cells per well. The plates were then incubated overnight.', /number 6|introduces the number 5/);
    expect(checkRewrite('We seeded 1×10⁶ cells per well; the plates were then incubated overnight.', 'We seeded 1×10^6 cells per well. The plates were then incubated overnight.').ok).toBe(true);
  });
  it('catches an inverted ratio', () => {
    bad('The ratio was 1:2 in treated cells; controls were not diluted at all here.', 'The ratio was 2:1 in treated cells. Controls were not diluted at all here.', /ratio 1:2/);
  });
  it('catches a lost minus sign, ASCII or U+2212', () => {
    bad('The shift was -3 mV in the mutant; the wild type did not move at all.', 'The shift was 3 mV in the mutant. The wild type did not move at all.', /sign of -3/);
    bad('The shift was −3 mV in the mutant; the wild type did not move at all.', 'The shift was 3 mV in the mutant. The wild type did not move at all.', /sign of -3/);
  });
  it('catches lower-then-upper names such as mTOR and cGAS', () => {
    bad('mTOR rather than cGAS signalling explains the response seen in these cells.', 'Signalling explains the response seen in these cells.', /mTOR/);
    bad('mTOR rather than cGAS signalling explains the response seen in these cells.', 'The mTOR signalling explains the response seen in these cells.', /cGAS/);
  });
  it('catches an invented citation marker and a duplicated one', () => {
    bad(original, 'Barrier height selects the functional state. We measured 42 complexes at pH 5.5 [3][7].', /citation \[7\] that the original does not/);
    bad(original, 'Barrier height selects the functional state [3]. We measured 42 complexes at pH 5.5 [3].', /citation \[3\] that the original does not/);
  });
  it('catches an invented number', () => {
    bad(original, 'Barrier height selects the functional state. We measured 42 complexes at pH 5.5 in 3 runs [3].', /introduces the number 3\b/);
  });
  it('compares markers as a multiset, in any order', () => {
    const o = 'First claim [2] holds; second claim [3-5] holds as well in these cells.';
    expect(checkRewrite(o, 'Second claim [3-5] holds. First claim [2] holds as well in these cells.').ok).toBe(true);
    bad(o, 'First claim [2] holds. Second claim [3, 5] holds as well in these cells.', /\[3-5\] is missing/);
  });
  it('accepts a spaced or en-dash range marker as the same marker', () => {
    const o = 'First claim holds [3-5]; second claim holds as well in these cells.';
    expect(checkRewrite(o, 'First claim holds [3–5]. Second claim holds as well in these cells.').ok).toBe(true);
  });
  // Accepted fail-safe false rejections (cost a retry and a flag, never a wrong apply): "45%" -> "45 percent",
  // "Egfr" vs "EGFR", "1,200" -> "1.200", and a thin-space thousands separator.
});

describe('guards: tell rules each pinned on their own (round 1)', () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  it('rejects a rewrite that removes three of four strong tells and keeps one, naming it', () => {
    const o = 'The state is selected kinetically rather than thermodynamically; the effect is what we saw, which is clear in all six runs. It is not a trap but a route.';
    const r = checkRewrite(o, 'Kinetics select the state rather than thermodynamics. We saw the effect in all six runs. It is a route.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/still contains "rather than"/);
  });
  it('rejects when the weighted tell score is not lower even though the sentence got much shorter', () => {
    const o = `Notably, ${filler(40)} held in the assay.`;
    const r = checkRewrite(o, 'Notably, the assay held.');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/style score/);
  });
  it('rejects when tells fell slightly but the sentence got longer, so worst severity did not drop', () => {
    const o = `We tested alpha, beta and gamma ${filler(30)} in the assay.`;
    const longer = `We tested several different agents ${filler(30)} in the assay under ordinary conditions at room temperature.`;
    const r = checkRewrite(o, longer);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/style score/);
  });
});

describe('round 2 pins', () => {
  it('rejects one [3] where the original has two', () => {
    const o = 'The first claim holds [3]; the second claim also holds in these cells [3].';
    const r = checkRewrite(o, 'The first claim holds. The second claim also holds in these cells [3].');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/\[3\] is missing/);
  });
  it('treats [3;4], [3 , 4] and [3,4] as the same marker', () => {
    const o = 'The first claim holds [3,4], which is clear in all of the cells we examined.';
    expect(checkRewrite(o, 'The first claim holds [3 , 4]. Both claims are clear in all of the cells we examined.').ok).toBe(true);
    // [3;4] counts as equal at the marker level (the semicolon inside it is also a tell, so checkRewrite is stricter by design).
    expect(compareMarkers('claim [3,4] here', 'claim [3;4] here').ok).toBe(true);
    expect(compareMarkers('claim [3,4] here', 'claim [3–4] here').ok).toBe(false);
  });
  it('maps subscript digits to plain digits and rejects a changed one', () => {
    const o = 'Cells grew in CO₂ at 5 percent; the medium was changed daily for the whole run.';
    expect(checkRewrite(o, 'Cells grew in CO2 at 5 percent. The medium was changed daily for the whole run.').ok).toBe(true);
    expect(checkRewrite(o, 'Cells grew in CO₃ at 5 percent. The medium was changed daily for the whole run.').ok).toBe(false);
  });
});

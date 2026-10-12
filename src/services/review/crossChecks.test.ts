import { describe, it, expect } from 'vitest';
import type { Section, SectionKind } from './types';
import { aimListMismatch, crossChecks, entityDrift, milestoneOverrun, quantityDisagreements } from './crossChecks';

function sec(key: string, kind: SectionKind, title: string, text: string): Section {
  return { key, kind, title, level: 1, from: 0, to: 0, headingFrom: 0, headingTo: 0, text };
}

describe('quantityDisagreements', () => {
  it('flags a dose given two ways, anchored at both sites', () => {
    const f = quantityDisagreements([
      sec('aims#0', 'aims', 'Aims', 'Seedlings are treated with 5 mg of abscisic acid per plant.'),
      sec('approach#0', 'approach', 'Approach', 'Each seedling receives 10 mg of abscisic acid per plant.'),
    ]);
    expect(f.map(x => x.sectionKey).sort()).toEqual(['aims#0', 'approach#0']);
    expect(f.every(x => x.checkId === 'g-con-numbers')).toBe(true);
  });
  it('stays quiet on a deliberate dose series in one sentence', () => {
    const f = quantityDisagreements([
      sec('approach#0', 'approach', 'Approach', 'Seedlings receive 1, 5 and 10 mg of abscisic acid per plant.'),
    ]);
    expect(f).toEqual([]);
  });
  it('reads a Symbol-font micro sign as a unit', () => {
    const f = quantityDisagreements([
      sec('a#0', 'aims', 'Aims', 'Biofilms are exposed to 5g of tobramycin per well.'),
      sec('b#0', 'approach', 'Approach', 'Biofilms are exposed to 20 µg of tobramycin per well.'),
    ]);
    expect(f.length).toBe(2);
  });
  it('requires whitespace before an ambiguous unit', () => {
    const f = quantityDisagreements([
      sec('a#0', 'aims', 'Aims', 'The 3M mutant lacks the efflux pump.'),
      sec('b#0', 'approach', 'Approach', 'The 5M mutant lacks the efflux pump.'),
    ]);
    expect(f).toEqual([]);
    const g = quantityDisagreements([
      sec('a#0', 'aims', 'Aims', 'Cells grow in 3 M urea buffer.'),
      sec('b#0', 'approach', 'Approach', 'Cells grow in 5 M urea buffer.'),
    ]);
    expect(g.length).toBe(2);
  });
});

describe('entityDrift', () => {
  const common = 'The strain PA14 forms biofilms. We grow PA14 overnight. PA14 is plated. PA14 is imaged. ';
  it('flags a name that appears once next to a dominant near-identical name', () => {
    const f = entityDrift([sec('m#0', 'approach', 'Methods', common + 'We then wash PAK14 twice.')]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ checkId: 'g-con-terms', severity: 'minor' });
    expect(f[0].issue).toContain('PAK14');
  });
  it('ignores numbered variants and figure legends', () => {
    expect(entityDrift([sec('m#0', 'approach', 'Methods', 'Line F1 grows. Line F1 is dense. Line F1 is pale. Line F1 is tall. Line F2 is new.')])).toEqual([]);
    expect(entityDrift([sec('m#0', 'approach', 'Methods', common + 'Figure 2. Panel PAK14 shows the merged channel.')])).toEqual([]);
  });
  it('accepts a legitimately new reagent introduced once', () => {
    expect(entityDrift([sec('m#0', 'approach', 'Methods', common + 'We add the reporter GFP7 once.')])).toEqual([]);
  });
  it('ignores a citation number glued onto a common name', () => {
    expect(entityDrift([sec('m#0', 'approach', 'Methods', common + 'As shown for PA143.')])).toEqual([]);
  });
});

describe('milestoneOverrun', () => {
  const t = (text: string) => [sec('approach#0', 'approach', 'Timeline', text)];
  it('flags a milestone beyond the project period', () => {
    const f = milestoneOverrun(t('Field trials finish in Y6Q3.'), 5);
    expect(f).toHaveLength(1);
    expect(f[0].checkId).toBe('g-fea-timeline');
  });
  it('stays quiet inside the period or without a period', () => {
    expect(milestoneOverrun(t('Field trials finish in Y5Q4, year 3 data follow.'), 5)).toEqual([]);
    expect(milestoneOverrun(t('Field trials finish in Y6Q3.'))).toEqual([]);
  });
});

describe('aimListMismatch', () => {
  it('flags a sub-aim missing from the aims page', () => {
    const f = aimListMismatch([
      sec('aims#0', 'aims', 'Specific Aims', 'Aim 1 maps drought genes. Aim 2 tests them. Aim 2a covers roots.'),
      sec('approach#0', 'approach', 'Approach', 'Aim 1 uses mapping. Aim 2a covers roots. Aim 2b covers leaves.'),
    ]);
    expect(f.some(x => x.issue.startsWith('Aim 2b'))).toBe(true);
  });
  it('does not demand that every sub-sub-aim be itemised on the aims page', () => {
    // C1.2a and C1.2b exist only in the Approach and no child of C1.2 is listed, so this is style, not a gap.
    // C2.2e is a gap: its siblings C2.2a and C2.2b ARE listed. Measured on a real R01, 2026-10-11.
    const f = aimListMismatch([
      sec('aims#0', 'aims', 'Specific Aims', 'C1.2 screens isolates. C2.2 tests them. C2.2a uses soil. C2.2b uses water.'),
      sec('approach#0', 'approach', 'Approach', 'C1.2a screens by plate. C1.2b screens by broth. C2.2a uses soil. C2.2b uses water. C2.2e adds a field trial.'),
    ]);
    expect(f.map(x => x.issue.split(' ')[0])).toEqual(['C2.2e']);
  });

  it('reports an aim promised on the aims page that the approach never delivers, with no sibling needed', () => {
    const f = aimListMismatch([
      sec('aims#0', 'aims', 'Specific Aims', 'Aim 1 maps genes. Aim 2 tests them. Aim 2b extends to leaves.'),
      sec('approach#0', 'approach', 'Approach', 'Aim 1 uses mapping. Aim 2 uses assays.'),
    ]);
    expect(f.some(x => x.issue.startsWith('Aim 2b') && /never describes it/.test(x.issue))).toBe(true);
  });

  it('stays quiet when the approach uses a numbering scheme with no counterpart on the aims page', () => {
    const f = aimListMismatch([
      sec('aims#0', 'aims', 'Specific Aims', 'Aim 1 maps drought genes. Aim 2 tests them.'),
      sec('approach#0', 'approach', 'Approach', 'Project 7 uses mapping. Project 7 uses trials.'),
    ]);
    expect(f).toEqual([]);
  });
});

describe('crossChecks', () => {
  it('runs all four and ignores references', () => {
    const f = crossChecks([
      sec('aims#0', 'aims', 'Aims', 'Aim 1 maps genes. Done in Y7Q1.'),
      sec('refs#0', 'references', 'References', 'Y9Q9 5 mg 10 mg.'),
    ], 5);
    expect(f.map(x => x.checkId)).toEqual(['g-fea-timeline']);
  });
  it('scans a 25k-character document quickly', () => {
    const para = 'Seedlings receive 5 mg of abscisic acid and 1, 2, 3, 4 and 5 mg of salt, as in PA14 and Aim 1, year 2. ';
    const text = para.repeat(250);
    expect(text.length).toBeGreaterThan(25000);
    const t0 = performance.now();
    crossChecks([sec('a#0', 'aims', 'Aims', text), sec('b#0', 'approach', 'Approach', text)], 5);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

import { describe, it, expect } from 'vitest';
import { FIDELITY, createReport, recordFeature, addWarning, summarizeReport } from './fidelity';

describe('fidelity table (spec §1)', () => {
  it('assigns the spec categories', () => {
    expect(FIDELITY.paragraph).toBe(1);
    expect(FIDELITY.trackedChange).toBe(1);
    expect(FIDELITY.floatingImageSquare).toBe(1);
    expect(FIDELITY.googleWrapper).toBe(1);
    expect(FIDELITY.floatingImageOther).toBe(2);
    expect(FIDELITY.externalCitation).toBe(2);
    expect(FIDELITY.equation).toBe(3);
    expect(FIDELITY.footnoteRef).toBe(3);
    expect(FIDELITY.activeX).toBe(4);
  });
});

describe('import report', () => {
  it('counts features per category', () => {
    const r = createReport();
    recordFeature(r, 'paragraph', 10);
    recordFeature(r, 'equation');
    expect(r.counts.paragraph).toBe(10);
    expect(r.byCategory[1]).toBe(10);
    expect(r.byCategory[3]).toBe(1);
  });

  it('category-4 features always produce a warning', () => {
    const r = createReport();
    recordFeature(r, 'activeX');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].category).toBe(4);
  });

  it('summary mentions pages, revisions, comments, preserved items, warnings', () => {
    const r = createReport();
    r.pageCount = 17;
    recordFeature(r, 'trackedChange', 32);
    recordFeature(r, 'comment', 52);
    recordFeature(r, 'equation', 2);
    addWarning(r, 'part', 'customXml/item9.xml could not be parsed');
    const s = summarizeReport(r);
    expect(s).toContain('17 pages');
    expect(s).toContain('32 tracked changes');
    expect(s).toContain('52 comments');
    expect(s).toContain('2 preserved read-only');
    expect(s).toContain('1 warning');
  });

  it('summary of an empty report is still readable', () => {
    expect(summarizeReport(createReport())).toBe('Imported document');
  });
});

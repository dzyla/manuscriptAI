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
    expect(FIDELITY.inferredHeading).toBe(2);
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

  it('summary does not count a tracked change or a comment anchor a second time as "preserved read-only"', () => {
    const r = createReport();
    recordFeature(r, 'trackedChange', 32);
    recordFeature(r, 'comment', 52);
    recordFeature(r, 'unknownField', 184); // 32 revisions + 152 anchors, each an atom
    r.described = { trackedChange: 32, commentAnchor: 152, citationField: 0 };
    expect(summarizeReport(r)).toBe('Imported 32 tracked changes · 52 comments');
    recordFeature(r, 'equation', 2);
    expect(summarizeReport(r)).toBe('Imported 32 tracked changes · 52 comments · 2 other preserved read-only');
    // a report that was not annotated keeps the plain total
    delete r.described;
    expect(summarizeReport(r)).toContain('186 preserved read-only');
  });

  it('summary counts lists, pluralised', () => {
    const r = createReport();
    recordFeature(r, 'list', 5);
    expect(summarizeReport(r)).toBe('Imported 5 lists');
    const one = createReport();
    recordFeature(one, 'list');
    expect(summarizeReport(one)).toBe('Imported 1 list');
  });

  it('summary names bibliographies, pluralised, next to citations', () => {
    const one = createReport();
    recordFeature(one, 'externalCitation', 22);
    recordFeature(one, 'externalBibliography');
    expect(summarizeReport(one)).toContain('22 citations · 1 bibliography');
    const two = createReport();
    recordFeature(two, 'externalBibliography', 2);
    expect(summarizeReport(two)).toContain('2 bibliographies');
  });

  it('summary of an empty report is still readable', () => {
    expect(summarizeReport(createReport())).toBe('Imported document');
  });
});

import { describe, it, expect } from 'vitest';
import { FIDELITY, createReport, recordFeature, addWarning, summarizeReport, preservedReadOnly } from './fidelity';

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

  it('the "other preserved" figure is a plain subtraction: pieces beyond the described ones show, and an over-count is not clamped away', () => {
    const r = createReport();
    recordFeature(r, 'unknownField', 11); // a citation field's 8 pieces and a PAGEREF field's 3
    r.described = { trackedChange: 0, commentAnchor: 0, citationField: 8 };
    expect(preservedReadOnly(r)).toEqual({ count: 3, hasDescribed: true });
    expect(summarizeReport(r)).toBe('Imported 3 other preserved read-only');
    // a described total that exceeds the atoms (a double count somewhere) is visible as a negative figure, not hidden as 0
    r.described = { trackedChange: 0, commentAnchor: 0, citationField: 12 };
    expect(preservedReadOnly(r).count).toBe(-1);
  });

  it('summary says when none of the comments is anchored in the text, and only then', () => {
    const r = createReport();
    recordFeature(r, 'comment', 4);
    r.commentsNotInText = 4;
    expect(summarizeReport(r)).toBe('Imported 4 comments (none anchored in the text)');
    r.commentsNotInText = 3;
    expect(summarizeReport(r)).toBe('Imported 4 comments');
    delete r.commentsNotInText;
    expect(summarizeReport(r)).toBe('Imported 4 comments');
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

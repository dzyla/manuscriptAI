// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ImportReportDialog, { ImportProgressDialog, reportRows, readRows, type ReportedImport } from './ImportReportDialog';
import { readDocx } from '../docx/read';
import { createReport, recordFeature, addWarning, summarizeReport } from '../docx/fidelity';
import { loadDocx } from '../test/docxFixtures';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => { root?.unmount(); }); host?.remove(); root = null; host = null; });

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
  return host;
}
const q = (el: ParentNode, sel: string) => el.querySelector(sel) as HTMLElement;
const qa = (el: ParentNode, sel: string) => Array.from(el.querySelectorAll(sel)) as HTMLElement[];
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const button = (el: ParentNode, label: RegExp) => qa(el, 'button').find(b => label.test(b.textContent ?? ''))!;

/** A report in which every kind of thing is present, with DIFFERENT counts so a merged figure cannot pass for the separate ones. */
function busyReport() {
  const r = createReport();
  recordFeature(r, 'trackedChange', 7);
  recordFeature(r, 'formatChange', 3);
  recordFeature(r, 'comment', 5);
  recordFeature(r, 'equation', 11);
  recordFeature(r, 'list', 2);
  recordFeature(r, 'table', 1);
  recordFeature(r, 'inlineImage', 4);
  r.commentsNotInText = 2;
  r.pageCount = 9;
  addWarning(r, 'part', 'First warning text', 3);
  addWarning(r, 'trackedChange', 'Second warning text', 3);
  return r;
}

describe('reportRows', () => {
  it('keeps tracked changes, formatting changes, comments, read-only pieces and warnings as separate figures', () => {
    const rows = reportRows({ report: busyReport() });
    const by = Object.fromEntries(rows.map(r => [r.key, r.value]));
    expect(by).toEqual({ trackedChange: 7, formatChange: 3, comment: 5, preserved: 11, warning: 2 });
    // no row is the sum of others
    expect(rows.map(r => r.value)).not.toContain(10);
    expect(rows.map(r => r.value)).not.toContain(27);
  });

  it('says how many comments are not anchored in the main text, and when none is', () => {
    const r = busyReport();
    expect(reportRows({ report: r }).find(x => x.key === 'comment')?.note).toBe('2 of them are not anchored in the main text.');
    r.commentsNotInText = 5;
    expect(reportRows({ report: r }).find(x => x.key === 'comment')?.note).toBe('None is anchored in the main text.');
    delete r.commentsNotInText;
    expect(reportRows({ report: r }).find(x => x.key === 'comment')?.note).toBeUndefined();
  });

  it('leaves out what is not there, and counts "other" preserved pieces apart from the ones already described', () => {
    expect(reportRows({ report: createReport() })).toEqual([]);
    const r = createReport();
    recordFeature(r, 'equation', 6); // six read-only atoms in all...
    r.described = { trackedChange: 4, commentAnchor: 0, citationField: 0 };
    // ...four of which are tracked-change atoms, already counted as tracked changes: only the other two are "other" pieces
    const rows = reportRows({ report: r });
    expect(rows.find(x => x.key === 'preserved')).toMatchObject({ value: 2, label: 'Other pieces preserved read-only' });
  });

  it('readRows lists what was read for orientation', () => {
    expect(Object.fromEntries(readRows({ report: busyReport() }).map(r => [r.key, r.value]))).toEqual({ page: 9, list: 2, table: 1, image: 4 });
  });

  it('readRows adds the three kinds of picture together, both kinds of citation together, and shows bibliographies on their own', () => {
    const r = createReport();
    recordFeature(r, 'inlineImage', 3);
    recordFeature(r, 'floatingImageSquare', 5);
    recordFeature(r, 'floatingImageOther', 7);
    recordFeature(r, 'nativeCitation', 11);
    recordFeature(r, 'externalCitation', 13);
    recordFeature(r, 'externalBibliography', 2);
    expect(Object.fromEntries(readRows({ report: r }).map(x => [x.key, x.value]))).toEqual({ image: 15, citation: 24, bibliography: 2 });
  });
});

describe('the caption row', () => {
  it('readRows says how many pictures were paired with a caption, and out of how many', () => {
    const r = createReport();
    recordFeature(r, 'inlineImage', 6);
    r.figures = { images: 6, captioned: 4 };
    const row = readRows({ report: r }).find(x => x.key === 'figureCaption');
    expect(row).toMatchObject({ value: 4, label: 'Pictures paired with a caption (of 6)' });
  });

  it('shows 0 for a document whose pictures have no captions (a missing pairing is information, not noise)', () => {
    const r = createReport();
    r.figures = { images: 3, captioned: 0 };
    expect(readRows({ report: r }).find(x => x.key === 'figureCaption')).toMatchObject({ value: 0, label: 'Pictures paired with a caption (of 3)' });
  });

  it('a negative read-only figure is a row, not a vanished one', () => {
    const r = createReport();
    recordFeature(r, 'unknownField', 3);
    r.described = { trackedChange: 0, commentAnchor: 0, citationField: 4 }; // 4 pieces described, 3 atoms: a double count somewhere
    expect(reportRows({ report: r }).find(x => x.key === 'preserved')).toMatchObject({ value: -1 });
  });

  it('has no caption row for a document without pictures', () => {
    expect(readRows({ report: createReport() }).some(x => x.key === 'figureCaption')).toBe(false);
  });

  it('is rendered in the dialog, from a real read', async () => {
    const result = await readDocx(loadDocx('images.docx'));
    const el = mount(<ImportReportDialog result={result} onConfirm={() => {}} onCancel={() => {}} />);
    expect(q(el, '[data-testid="row-figureCaption"]').textContent).toContain('Pictures paired with a caption (of 6)');
    expect(q(el, '[data-testid="row-figureCaption"]').textContent).toMatch(/1$/);
  });
});

describe('ImportReportDialog', () => {
  const noop = () => {};

  it('shows the summary line from summarizeReport and lists every warning', () => {
    const report = busyReport();
    const el = mount(<ImportReportDialog result={{ report, headingCandidates: [], fileName: 'x.docx' }} onConfirm={noop} onCancel={noop} />);
    expect(q(el, '[data-testid="import-summary"]').textContent).toBe(summarizeReport(report));
    const warnings = qa(el, '[data-testid="warnings"] li').map(li => li.textContent);
    expect(warnings).toEqual(['First warning text', 'Second warning text']);
    expect(q(el, '[data-testid="row-trackedChange"]').textContent).toContain('7');
    expect(q(el, '[data-testid="row-comment"]').textContent).toContain('5');
    expect(q(el, '[data-testid="row-comment"]').textContent).toContain('2 of them are not anchored in the main text.');
    expect(el.textContent).toContain('x.docx');
  });

  it('says that Undo will not bring the replaced document back, and says how it can be brought back', () => {
    const el = mount(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} onConfirm={noop} onCancel={noop} />);
    const text = q(el, '[data-testid="replace-notice"]').textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('Undo will not bring it back');
    expect(text).toContain('Restore previous document');
    expect(text).toContain('Version History');
    expect(text).toContain('Cancel');
  });

  it('view mode shows the stored report read-only: the accepted headings are ticked and locked, and there is only Close', () => {
    const cands = [1, 2, 3].map(i => ({ index: i, level: 1 as const, text: `Section ${i}`, evidence: [`why ${i}`], confidence: 'name' as const }));
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const report = busyReport();
    const el = mount(<ImportReportDialog mode="view" result={{ report, headingCandidates: cands, fileName: 'old.docx' }} acceptedIndexes={[2]} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(q(el, '[data-testid="view-notice"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="replace-notice"]')).toBeNull();
    expect(q(el, '[data-testid="import-summary"]').textContent).toBe(summarizeReport(report));
    expect(qa(el, '[data-testid="warnings"] li').map(li => li.textContent)).toEqual(['First warning text', 'Second warning text']);
    const boxes = qa(el, 'input[type="checkbox"]') as HTMLInputElement[];
    expect(boxes.map(b => b.checked)).toEqual([false, true, false]);
    expect(boxes.every(b => b.disabled)).toBe(true);
    expect(el.textContent).toContain('1 of 3 accepted');
    expect(qa(el, 'button').map(b => b.textContent)).toEqual(['Close']);
    click(button(el, /^Close$/));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('opens with focus on Cancel, the safe choice', () => {
    const el = mount(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} onConfirm={noop} onCancel={noop} />);
    expect(document.activeElement).toBe(button(el, /^Cancel$/));
  });

  it('clicking the backdrop cancels, unless the import is being written', () => {
    const onCancel = vi.fn();
    const el = mount(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} onConfirm={noop} onCancel={onCancel} />);
    click(q(el, '[data-testid="import-report-dialog"] > div.absolute'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => { root!.render(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} busy onConfirm={noop} onCancel={onCancel} />); });
    click(q(el, '[data-testid="import-report-dialog"] > div.absolute'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('labels each candidate with its level', () => {
    const result = {
      report: createReport(),
      headingCandidates: [1, 2, 3].map(level => ({ index: level, level: level as 1 | 2 | 3, text: `T${level}`, evidence: ['e'], confidence: 'format' as const })),
    };
    const el = mount(<ImportReportDialog result={result} onConfirm={noop} onCancel={noop} />);
    const labels = qa(el, '[data-testid="heading-candidates"] > li').map(li => li.textContent!.replace(/e$/, ''));
    expect(labels).toEqual(['H1T1', 'H2T2', 'H3T3']);
  });

  it('keeps Tab inside the dialog: from the last control to the first, and Shift+Tab back', () => {
    const result = { report: createReport(), headingCandidates: [{ index: 1, level: 1 as const, text: 'Aims', evidence: ['e'], confidence: 'name' as const }] };
    const el = mount(<ImportReportDialog result={result} onConfirm={noop} onCancel={noop} />);
    const dialog = q(el, '[role="dialog"]');
    const controls = qa(dialog, 'button, input');
    const first = controls[0];
    const last = controls[controls.length - 1];
    const press = (shiftKey: boolean) => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      act(() => { document.activeElement!.dispatchEvent(ev); });
      return ev;
    };
    last.focus();
    expect(press(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // in the middle Tab is left alone for the browser
    controls[1].focus();
    expect(press(false).defaultPrevented).toBe(false);
  });

  it('calls onCancel for Cancel and for Escape, and onConfirm for Import', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const el = mount(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} onConfirm={onConfirm} onCancel={onCancel} />);
    click(button(el, /^Cancel$/));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    click(button(el, /^Import/));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ acceptedHeadings: [] });
  });

  it('while busy, nothing can be clicked a second time and Escape does not cancel', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const el = mount(<ImportReportDialog result={{ report: createReport(), headingCandidates: [] }} busy onConfirm={onConfirm} onCancel={onCancel} />);
    for (const b of qa(el, 'button')) expect((b as HTMLButtonElement).disabled).toBe(true);
    click(qa(el, 'button')[1]);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a parent re-render with new callbacks does not pull focus back to Cancel, and Escape still reaches the latest callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const result = { report: createReport(), headingCandidates: [{ index: 0, level: 1 as const, text: 'Aims', evidence: ['e'], confidence: 'name' as const }] };
    const el = mount(<ImportReportDialog result={result} onConfirm={noop} onCancel={first} />);
    const box = q(el, 'input[type="checkbox"]');
    box.focus();
    expect(document.activeElement).toBe(box);
    act(() => { root!.render(<ImportReportDialog result={result} onConfirm={noop} onCancel={second} />); });
    expect(document.activeElement).toBe(box);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe('heading candidates (read from a real document, evidence as the reader wrote it)', () => {
    let result: ReportedImport;
    beforeAll(async () => {
      result = await readDocx(loadDocx('unstyled-sections.docx'), undefined, 'unstyled-sections.docx');
    });

    it('shows each candidate with every one of its evidence strings, unchanged', () => {
      expect(result.headingCandidates.length).toBeGreaterThan(2);
      const el = mount(<ImportReportDialog result={result} onConfirm={noop} onCancel={noop} />);
      const items = qa(el, '[data-testid="heading-candidates"] > li');
      expect(items).toHaveLength(result.headingCandidates.length);
      result.headingCandidates.forEach((h, i) => {
        expect(h.evidence.length).toBeGreaterThan(0);
        const shown = qa(items[i], '[data-testid="evidence"] li').map(li => li.textContent);
        expect(shown).toEqual(h.evidence); // verbatim, in order, none merged or dropped
        expect(items[i].textContent).toContain(h.text);
      });
    });

    it('accepts nothing until the author does: Import passes no heading', () => {
      const onConfirm = vi.fn();
      const el = mount(<ImportReportDialog result={result} onConfirm={onConfirm} onCancel={noop} />);
      for (const cb of qa(el, 'input[type="checkbox"]')) expect((cb as HTMLInputElement).checked).toBe(false);
      click(button(el, /^Import/));
      expect(onConfirm).toHaveBeenCalledWith({ acceptedHeadings: [] });
    });

    it('passes exactly the accepted candidates, per candidate', () => {
      const onConfirm = vi.fn();
      const el = mount(<ImportReportDialog result={result} onConfirm={onConfirm} onCancel={noop} />);
      const boxes = qa(el, 'input[type="checkbox"]');
      click(boxes[0]);
      click(boxes[2]);
      expect(el.textContent).toContain(`2 of ${result.headingCandidates.length} accepted`);
      click(button(el, /^Import with 2 headings$/));
      expect(onConfirm).toHaveBeenCalledWith({ acceptedHeadings: [result.headingCandidates[0], result.headingCandidates[2]] });
      // un-ticking takes one back out
      click(boxes[0]);
      click(button(el, /^Import with 1 heading$/));
      expect(onConfirm).toHaveBeenLastCalledWith({ acceptedHeadings: [result.headingCandidates[2]] });
    });

    it('Accept all and Reject all', () => {
      const onConfirm = vi.fn();
      const el = mount(<ImportReportDialog result={result} onConfirm={onConfirm} onCancel={noop} />);
      click(button(el, /^Accept all$/));
      for (const cb of qa(el, 'input[type="checkbox"]')) expect((cb as HTMLInputElement).checked).toBe(true);
      click(button(el, /^Import with/));
      expect(onConfirm).toHaveBeenLastCalledWith({ acceptedHeadings: result.headingCandidates });
      click(button(el, /^Reject all$/));
      for (const cb of qa(el, 'input[type="checkbox"]')) expect((cb as HTMLInputElement).checked).toBe(false);
      click(button(el, /^Import$/));
      expect(onConfirm).toHaveBeenLastCalledWith({ acceptedHeadings: [] });
    });
  });
});

describe('ImportProgressDialog', () => {
  it('keeps focus on its one button when Tab is pressed', () => {
    const el = mount(<ImportProgressDialog fileName="a.docx" onCancel={() => {}} />);
    const cancel = button(el, /^Cancel$/);
    expect(document.activeElement).toBe(cancel);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { cancel.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it('names the file (and its size when large), shows the step, and Cancel and Escape both get out', () => {
    const onCancel = vi.fn();
    const el = mount(<ImportProgressDialog fileName="big grant.docx" size={6.5 * 1024 * 1024} stage="body" onCancel={onCancel} />);
    expect(q(el, '[data-testid="progress-file"]').textContent).toBe('big grant.docx (6.5 MB)');
    expect(q(el, '[data-testid="progress-stage"]').textContent).toBe('Reading text, tables and images…');
    click(button(el, /^Cancel$/));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('does not print a size for a small file, and has a label before the first step is reported', () => {
    const el = mount(<ImportProgressDialog fileName="a.docx" size={2000} onCancel={() => {}} />);
    expect(q(el, '[data-testid="progress-file"]').textContent).toBe('a.docx');
    expect(q(el, '[data-testid="progress-stage"]').textContent).toBe('Starting…');
  });
});

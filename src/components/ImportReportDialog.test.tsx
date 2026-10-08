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

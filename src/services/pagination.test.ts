import { describe, it, expect } from 'vitest';
import { estimatePages, contentWidthIn } from './pagination';
import type { DocFormat } from '../types';

const letter: DocFormat = {
  page: { size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  styles: {}, defaults: { fontFamily: 'Arial', fontSizePt: 11 }, preset: 'nih',
};
const a4: DocFormat = { ...letter, page: { ...letter.page, size: 'a4' }, preset: 'a4' };
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (n: number, words = 20) => ({ type: 'doc', content: Array.from({ length: n }, () => para(Array(words).fill('word').join(' '))) });

describe('contentWidthIn', () => {
  it('is the page width less both margins', () => {
    expect(contentWidthIn(letter)).toBeCloseTo(8.5 - 1.0, 5);
    expect(contentWidthIn(a4)).toBeCloseTo(8.27 - 1.0, 1);
  });

  it('falls back to the NIH preset when the document has no format', () => {
    // A row saved before A1's migration, or a brand-new blank document.
    expect(contentWidthIn(null)).toBeGreaterThan(5);
    expect(contentWidthIn(null)).toBeLessThan(8.5);
  });

  it('never goes negative when margins exceed the page', () => {
    const silly: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: 1, right: 6, bottom: 1, left: 6 } } };
    expect(contentWidthIn(silly)).toBe(0);
  });
});

describe('estimatePages', () => {
  it('always reports itself as approximate until A3 replaces it', () => {
    expect(estimatePages(doc(10), letter).approximate).toBe(true);
  });

  it('reports one page for an empty document, not zero', () => {
    const e = estimatePages({ type: 'doc', content: [] }, letter);
    expect(e.pages).toBe(1);
    expect(e.breaks).toEqual([]);
  });

  it('grows monotonically with content', () => {
    const small = estimatePages(doc(10), letter).pages;
    const large = estimatePages(doc(200), letter).pages;
    expect(large).toBeGreaterThan(small);
  });

  it('fits fewer pages on a page with larger margins', () => {
    const wide: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: 2, right: 2, bottom: 2, left: 2 } } };
    expect(estimatePages(doc(100), wide).pages).toBeGreaterThan(estimatePages(doc(100), letter).pages);
  });

  it('counts an explicit page break as a break', () => {
    const d = { type: 'doc', content: [para('one'), { type: 'pageBreak' }, para('two')] };
    expect(estimatePages(d, letter).breaks.length).toBeGreaterThanOrEqual(1);
    expect(estimatePages(d, letter).pages).toBeGreaterThanOrEqual(2);
  });

  it('is stable across calls with the same input', () => {
    expect(estimatePages(doc(37), letter)).toEqual(estimatePages(doc(37), letter));
  });

  it('does not open with a blank page when a page break is the first node', () => {
    const d = { type: 'doc', content: [{ type: 'pageBreak' }, para('one')] };
    expect(estimatePages(d, letter).pages).toBe(1);
  });

  it('survives a zero font size and margins wider than the page', () => {
    const bad: DocFormat = {
      ...letter, defaults: { fontFamily: 'Arial', fontSizePt: 0 },
      page: { ...letter.page, marginsIn: { top: 9, right: 6, bottom: 9, left: 6 } },
    };
    const e = estimatePages(doc(50), bad);
    expect(Number.isFinite(e.pages)).toBe(true);
    expect(e.pages).toBeGreaterThanOrEqual(1);
  });

  it('reports one page for a figure-only document (flow is not modelled)', () => {
    expect(estimatePages({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] }, letter).pages).toBe(1);
  });

  it('stays fast on 10,000 short paragraphs', () => {
    const t = performance.now();
    const e = estimatePages(doc(10000, 3), letter);
    expect(performance.now() - t).toBeLessThan(500);
    expect(e.pages).toBeGreaterThan(10);
  });
});

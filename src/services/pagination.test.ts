import { describe, it, expect } from 'vitest';
import { estimatePages, contentWidthIn, contentHeightIn, charsPerLine, linesPerPage } from './pagination';
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
    expect(contentWidthIn(null)).toBe(7.5);
    expect(contentHeightIn(null)).toBe(10);
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

describe('estimatePages: block-level line accounting', () => {
  it('charges a short block a whole line, so 10,000 one-line paragraphs are ~167 pages, not ~9', () => {
    // NIH letter at 11pt: 112 chars/line x 60 lines/page; 10,000 lines / 60 = 166.7.
    const e = estimatePages(doc(10000, 3), letter);
    expect(e.pages).toBeGreaterThanOrEqual(160);
    expect(e.pages).toBeLessThanOrEqual(175);
  });

  it('charges headings and empty paragraphs a line each', () => {
    const blocks = Array.from({ length: 120 }, (_, i) => (i % 2 ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] } : { type: 'paragraph' }));
    expect(estimatePages({ type: 'doc', content: blocks }, letter).pages).toBe(2);
  });

  it('does not charge list or table containers a line of their own', () => {
    const list = { type: 'bulletList', content: Array.from({ length: 60 }, () => ({ type: 'listItem', content: [para('x')] })) };
    expect(estimatePages({ type: 'doc', content: [list] }, letter).pages).toBe(1);
  });

  it('rounds a long paragraph up to whole lines', () => {
    // cpl is 113 for NIH letter at 11pt, so 114 chars wrap to 2 lines.
    const n = (k: number) => ({ type: 'doc', content: Array.from({ length: k }, () => para('x'.repeat(114))) });
    expect(estimatePages(n(30), letter).pages).toBe(1); // 60 lines: exactly one page
    expect(estimatePages(n(31), letter).pages).toBe(2);
  });
});

describe('degenerate inputs', () => {
  const withSize = (fontSizePt: number): DocFormat => ({ ...letter, defaults: { fontFamily: 'Arial', fontSizePt } });
  const textOf = (chars: number) => ({ type: 'doc', content: [para('x'.repeat(chars))] });

  it('treats fontSizePt 0 and NaN as the 11pt baseline, not as huge capacity', () => {
    // 100 paragraphs of 112 chars = 100 lines = 2 pages at the baseline.
    const d = { type: 'doc', content: Array.from({ length: 100 }, () => para('x'.repeat(100))) };
    expect(estimatePages(d, withSize(0)).pages).toBe(2);
    expect(estimatePages(d, withSize(NaN)).pages).toBe(2);
    expect(estimatePages(d, withSize(-3)).pages).toBe(2);
    expect(estimatePages(textOf(5000), withSize(0)).pages).toBe(1);
  });

  it('survives non-finite margins', () => {
    const f: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: NaN, right: Infinity, bottom: 0.5, left: 0.5 } } };
    expect(Number.isFinite(contentWidthIn(f))).toBe(true);
    expect(Number.isFinite(estimatePages(doc(50), f).pages)).toBe(true);
  });

  it('does not throw on a null or empty doc', () => {
    expect(estimatePages(null, letter).pages).toBe(1);
    expect(estimatePages(undefined, letter).pages).toBe(1);
    expect(estimatePages({ type: 'doc' }, letter).pages).toBe(1);
  });

  it('keeps 10,000 paragraphs under a second', () => {
    const t = performance.now();
    estimatePages(doc(10000, 3), letter);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('font size changes capacity', () => {
  const at = (pt: number): DocFormat => ({ ...letter, defaults: { fontFamily: 'Arial', fontSizePt: pt } });
  it('a smaller font fits more per page, a larger one fewer', () => {
    const d = doc(2000, 3);
    const p10 = estimatePages(d, at(10)).pages;
    const p11 = estimatePages(d, at(11)).pages;
    const p22 = estimatePages(d, at(22)).pages;
    expect(p10).toBeLessThan(p11);
    expect(p11).toBeLessThan(p22);
  });
});

describe('line boundaries', () => {
  const lines = (chars: number, count: number) => ({ type: 'doc', content: Array.from({ length: count }, () => para('x'.repeat(chars))) });
  const perPage = linesPerPage(letter);

  it('a paragraph of exactly cpl characters is one line; cpl + 1 is two', () => {
    const cpl = charsPerLine(letter);
    // perPage one-line paragraphs fill exactly one page; one more spills.
    expect(estimatePages(lines(cpl, perPage), letter).pages).toBe(1);
    expect(estimatePages(lines(cpl, perPage + 1), letter).pages).toBe(2);
    // The same count at cpl + 1 characters is two lines each, hence twice the pages.
    expect(estimatePages(lines(cpl + 1, perPage), letter).pages).toBe(2);
  });

  it('charges a paragraph with three hard breaks four lines', () => {
    const br = { type: 'hardBreak' };
    const t = (x: string) => ({ type: 'text', text: x });
    const p = { type: 'paragraph', content: [t('a'), br, t('b'), br, t('c'), br, t('d')] };
    const n = (k: number) => ({ type: 'doc', content: Array.from({ length: k }, () => p) });
    expect(estimatePages(n(perPage / 4), letter).pages).toBe(1);
    expect(estimatePages(n(perPage / 4 + 1), letter).pages).toBe(2);
  });
});

describe('guards and floors', () => {
  it('counts a NaN margin as 0, not as poison', () => {
    const f: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: NaN } } };
    expect(contentWidthIn(f)).toBe(8);
  });

  it('floors characters per line at 20 and lines per page at 5 for absurd formats', () => {
    const huge: DocFormat = { ...letter, defaults: { fontFamily: 'Arial', fontSizePt: 1e6 } };
    expect(charsPerLine(huge)).toBe(20);
    expect(linesPerPage(huge)).toBe(5);
    const e = estimatePages(doc(100, 3), huge);
    expect(Number.isFinite(e.pages)).toBe(true);
    expect(e.pages).toBe(20); // 100 lines x 20 chars / (20 x 5) per page
    const crushed: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: 20, right: 20, bottom: 20, left: 20 } } };
    expect(charsPerLine(crushed)).toBe(20);
    expect(linesPerPage(crushed)).toBe(5);
  });
});

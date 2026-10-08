import type { JSONContent } from '@tiptap/core';
import type { DocFormat } from '../types';
import { PAGE_SIZES_IN, createFormat } from './formatPresets';

/**
 * The ONLY source of a page number in the app. The page guides and the
 * status bar both read this; nothing else may compute one.
 *
 * THIS IS THE SEAM FOR SUB-PROJECT A3. A3 replaces the body of `estimatePages`
 * with real layout measurement and flips `approximate` to `false`. The shape of
 * `PageEstimate` and the signatures below are the contract: no UI change is
 * needed when it lands, because callers already branch on `approximate`.
 *
 * Until then every figure is a character-density estimate. It does NOT model
 * figures, tables, images, headings' extra spacing, per-style line spacing,
 * list indents, orphan/widow control, keep-with-next or section breaks.
 */
export interface PageEstimate {
  pages: number;
  /** true while this is a character-density estimate rather than real layout */
  approximate: boolean;
  /** character offsets (into the flattened text) after which a page boundary is estimated to fall */
  breaks: number[];
}

const DEFAULT_FORMAT: DocFormat = createFormat('nih');

function fmt(format: DocFormat | null): DocFormat {
  return format ?? DEFAULT_FORMAT;
}

export function contentWidthIn(format: DocFormat | null): number {
  const f = fmt(format);
  const { width } = PAGE_SIZES_IN[f.page.size];
  return Math.max(0, width - f.page.marginsIn.left - f.page.marginsIn.right);
}

/** Printable page height in inches, never negative. */
export function contentHeightIn(format: DocFormat | null): number {
  const f = fmt(format);
  const { height } = PAGE_SIZES_IN[f.page.size];
  return Math.max(0, height - f.page.marginsIn.top - f.page.marginsIn.bottom);
}

function fontScale(f: DocFormat): number {
  return 11 / Math.max(1, f.defaults.fontSizePt);
}

/** Characters per line, from the NIH 15-characters-per-inch guidance. */
function charsPerLine(f: DocFormat): number {
  return Math.max(20, Math.round(contentWidthIn(f) * 15 * fontScale(f)));
}

/** Lines per page, from the NIH 6-lines-per-inch guidance. */
function linesPerPage(f: DocFormat): number {
  return Math.max(5, Math.round(contentHeightIn(f) * 6 * fontScale(f)));
}

interface Acc { length: number; hardBreaks: number[] }

function walk(node: JSONContent, out: Acc): void {
  if (node.type === 'pageBreak') { out.hardBreaks.push(out.length); return; }
  if (node.type === 'text') { out.length += (node.text ?? '').length; return; }
  for (const child of node.content ?? []) walk(child, out);
  // A block ends its line.
  if (node.type && node.type !== 'doc') out.length += 1;
}

export function estimatePages(doc: JSONContent, format: DocFormat | null): PageEstimate {
  const f = fmt(format);
  const acc: Acc = { length: 0, hardBreaks: [] };
  walk(doc, acc);

  const perPage = charsPerLine(f) * linesPerPage(f);

  const breaks: number[] = [];
  let consumed = 0;
  for (const at of acc.hardBreaks) {
    // A page break that opens the document starts nothing new.
    if (at === 0) continue;
    // Natural overflow before the hard break comes first.
    while (at - consumed > perPage) { consumed += perPage; breaks.push(consumed); }
    consumed = at;
    breaks.push(at);
  }
  while (acc.length - consumed > perPage) { consumed += perPage; breaks.push(consumed); }

  return { pages: breaks.length + 1, approximate: true, breaks };
}

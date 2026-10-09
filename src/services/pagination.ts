import type { JSONContent } from '@tiptap/core';
import type { DocFormat } from '../types';
import { PAGE_SIZES_IN, createFormat } from './formatPresets';

/**
 * The single source of a DOCUMENT page count. The page guides in the editor
 * read this for how many page boundaries to draw and for their "p. N" labels;
 * the status bar reads it too (`usePageEstimate` in shell/shellLogic.ts). Nothing else may compute a
 * document page count.
 *
 * What is measured versus estimated today: the NUMBER of pages and the labels
 * come from here (an estimate). The vertical PIXEL position of each guide is
 * still taken from the DOM (page pitch derived from the rendered content
 * width and the format's page shape), because that is where a boundary must
 * be drawn to line up with the rendered text.
 *
 * THIS IS THE SEAM FOR SUB-PROJECT A3. A3 replaces the body of `estimatePages`
 * with real layout measurement and flips `approximate` to `false`. The shape
 * of `PageEstimate` and the signatures below are the contract: no UI change is
 * needed when it lands, because every caller already goes through here.
 *
 * Until then every figure is a character-density estimate. It does NOT model
 * figures, images, tables, heading spacing, per-style line spacing, list
 * indents, orphan/widow control, keep-with-next or section breaks.
 *
 * Deliberately separate: `wordsToPages` / `WORDS_PER_PAGE` (grantTemplates.ts)
 * is a section-level WORD BUDGET for grant sections, not a document page
 * count. It is out of scope here; A3 should know it exists and leave it be.
 */
export interface PageEstimate {
  pages: number;
  /** true while this is a character-density estimate rather than real layout */
  approximate: boolean;
  /** offsets (in line-rounded characters) after which a page boundary is estimated to fall */
  breaks: number[];
}

const DEFAULT_FORMAT: DocFormat = createFormat('nih');

function fmt(format: DocFormat | null): DocFormat {
  return format ?? DEFAULT_FORMAT;
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

export function contentWidthIn(format: DocFormat | null): number {
  const f = fmt(format);
  const { width } = PAGE_SIZES_IN[f.page.size];
  return Math.max(0, width - finite(f.page.marginsIn.left) - finite(f.page.marginsIn.right));
}

/** Printable page height in inches, never negative. */
export function contentHeightIn(format: DocFormat | null): number {
  const f = fmt(format);
  const { height } = PAGE_SIZES_IN[f.page.size];
  return Math.max(0, height - finite(f.page.marginsIn.top) - finite(f.page.marginsIn.bottom));
}

/** 11pt is the NIH baseline; a missing, zero, negative or NaN size falls back to it. */
function fontScale(f: DocFormat): number {
  const pt = f.defaults.fontSizePt;
  return 11 / (Number.isFinite(pt) && pt > 0 ? Math.max(1, pt) : 11);
}

/** Characters per line, from the NIH 15-characters-per-inch guidance. */
export function charsPerLine(f: DocFormat): number {
  return Math.max(20, Math.round(contentWidthIn(f) * 15 * fontScale(f)));
}

/** Lines per page, from the NIH 6-lines-per-inch guidance. */
export function linesPerPage(f: DocFormat): number {
  return Math.max(5, Math.round(contentHeightIn(f) * 6 * fontScale(f)));
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

interface Acc { length: number; hardBreaks: number[]; cpl: number; line: number }

/** Close the current line: it occupies whole lines, so round up to a multiple of cpl (an empty block is one line). */
function endLine(out: Acc): void {
  out.length += Math.max(1, Math.ceil(out.line / out.cpl)) * out.cpl;
  out.line = 0;
}

function walk(node: JSONContent, out: Acc): void {
  if (node.type === 'pageBreak') { out.hardBreaks.push(out.length); return; }
  if (node.type === 'text') { out.line += (node.text ?? '').length; return; }
  if (node.type === 'hardBreak') { endLine(out); return; }
  for (const child of node.content ?? []) walk(child, out);
  if (node.type && TEXT_BLOCKS.has(node.type)) endLine(out);
}

export function estimatePages(doc: JSONContent | null | undefined, format: DocFormat | null): PageEstimate {
  const f = fmt(format);
  const cpl = charsPerLine(f);
  const acc: Acc = { length: 0, hardBreaks: [], cpl, line: 0 };
  if (doc) walk(doc, acc);

  const perPage = cpl * linesPerPage(f);

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

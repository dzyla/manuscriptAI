/**
 * w:body -> the document's top-level blocks: paragraphs, tables, pictures and opaque blocks, with the lists grouped, in document
 * order. This is the one place that assembles them, so what each piece needs from the others is decided once:
 *
 *   - the document's images are loaded and hashed first (`prepareMedia`), because reading a paragraph is synchronous;
 *   - the numbering part is parsed once (`getNumbering`), and the body's lists share one count across the tables that interrupt
 *     them, so a list that resumes after a table still resumes. The body is grouped one stretch at a time, a stretch ending at
 *     each table, and each stretch is noted (`noteListCounts`) BEFORE the next table is read: a table-cell list and a body list
 *     that share a numbering are then seen in document order, and reported as `complexNumbering` (category 2);
 *   - headings are inferred from the RESULT (`inferHeadings(doc)`), so every index it works with is a position in exactly this
 *     array, pictures and tables included.
 *
 * The block's other readers stay what they were: `readParagraph`, `readTable`, `readOpaque`.
 */
import type { JSONContent } from '@tiptap/core';
import { PAGE_SIZES_IN } from '../../services/formatPresets';
import type { ReadContext } from './context';
import { matchCaptions, prepareMedia, type FigureMatch } from './drawings';
import { getNumbering, groupListParagraphs, noteListCounts, type ListCounters } from './numbering';
import { classifyOpaque, readOpaque } from './opaque';
import { isW } from './ooxml';
import { readPageSetup } from './pageSetup';
import { blockChildren, readParagraph } from './paragraphs';
import { readTable } from './tables';

export interface BodyResult {
  /** The grouped top-level blocks. */
  blocks: JSONContent[];
  /** Each picture in `blocks` with the caption found for it (see `matchCaptions`). */
  figures: FigureMatch[];
}

/** The text area's width in inches from the body's page setup (nothing is recorded in the report; the importer records page setup once). */
function contentWidthOf(body: Element): number | undefined {
  const { page } = readPageSetup(body);
  const width = PAGE_SIZES_IN[page.size]?.width;
  const text = width === undefined ? 0 : width - page.marginsIn.left - page.marginsIn.right;
  return text > 0 ? text : undefined;
}

export async function readBody(body: Element, ctx: ReadContext): Promise<BodyResult> {
  ctx.contentWidthIn ??= contentWidthOf(body);
  await prepareMedia(ctx, body);
  const numbering = getNumbering(ctx);
  const counters: ListCounters = new Map();

  const blocks: JSONContent[] = [];
  let stretch: JSONContent[] = [];
  const flush = (): void => {
    if (!stretch.length) return;
    const grouped = groupListParagraphs(stretch.map(node => ({ node })), numbering, ctx, counters);
    noteListCounts(ctx, 'body', grouped, numbering);
    blocks.push(...grouped);
    stretch = [];
  };

  for (const el of blockChildren(body, ctx)) {
    if (isW(el, 'sectPr')) continue; // the page setup (readPageSetup)
    if (isW(el, 'p')) {
      stretch.push(...[readParagraph(el, ctx)].flat());
      continue;
    }
    flush();
    if (isW(el, 'tbl')) blocks.push(readTable(el, ctx));
    else {
      const c = classifyOpaque(el);
      blocks.push(readOpaque(el, ctx, c.kind, c.label, { block: true }));
    }
  }
  flush();
  return { blocks, figures: matchCaptions(blocks) };
}

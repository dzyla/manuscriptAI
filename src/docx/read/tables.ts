/**
 * w:tbl -> table / tableRow / tableCell / tableHeader nodes.
 *
 * What the model expresses, and so reads as category 1: the grid's column widths (`colwidth`, CSS px = twips / 15), header rows
 * (`tableHeader`), horizontal merges (`gridSpan` -> `colspan`), vertical merges (`vMerge` -> `rowspan`), nested tables, and any
 * block a cell can hold (paragraphs, lists, opaque blocks).
 *
 * Nothing is rewritten and nothing the model cannot hold is dropped. What a writer needs to rebuild a table:
 *   - the table's own original XML: `preservation.blocks[table.attrs.ooxml.blockId]`, the whole `<w:tbl>` (borders, shading,
 *     cell margins, row heights, the style, every revision mark, the cells that were folded into a rowspan, ...). A nested
 *     table has its own entry and is also inside its parent's;
 *   - the structure that is in the model: row i is the i-th `<w:tr>`; a cell is in the model at its grid column, found by
 *     walking the row with `colspan` and the `rowspan` of the cells above (a row below a merged cell has one fewer cell). The
 *     `<w:tc>` that were folded into a rowspan are blank in the source and exist only in the table's fragment;
 *   - each paragraph in a cell has its own `ooxml` provenance and fragment, exactly as in the body.
 * WRITER RULES that live elsewhere and are easy to miss from here (all in docs/superpowers/specs/2026-10-07-a2b-writer-contract.md
 * section 5): (a) the row-and-cell correspondence above holds only while `isTableShellUnchanged(table)` (preserve/hash.ts); once a
 * row or column was added or deleted the table is rebuilt from the model, with its own rule for the folded cells; (b) even with the
 * shell reused, rebuild each cell's block sequence from the model by `blockId`; (c) a cell that ENDS in a nested table has no
 * trailing paragraph in the model, but Word requires one: append an empty `<w:p/>` (see the comment in `readCell`).
 *
 * A table property the model does not hold is recorded in the report (`tableBorders` for borders and shading, `tableLayout` for
 * structure and placement). For such a table the writer must treat the fragment as the authority, not rebuild from the model alone.
 *
 * Merges that cannot be expressed exactly stay cells. A vMerge continuation with nothing above it, with a different span, or
 * with content in it (Word hides that content) is read as an ordinary cell, so no cell and no text is ever dropped to make a
 * merge work.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature } from '../fidelity';
import { stampProvenance } from '../preserve/hash';
import { captureFragment } from '../preserve/xml';
import { specNormalizeNode } from '../../extensions/schemaSpecs';
import { trackIds, warnOnce, type ReadContext } from './context';
import { childElements, firstW, int, isW, onOff, wAttr } from './ooxml';
import { classifyOpaque, readOpaque, snapshotCommentIds } from './opaque';
import { blockChildren, readParagraph } from './paragraphs';
import { getNumbering, groupListParagraphs, noteListCounts } from './numbering';
import { dropAssetsAfter } from './drawings';

/** 1 twip = 1/1440 in = 96/1440 CSS px. */
const twipsToPx = (t: number): number => Math.max(1, Math.round(t / 15));

/** Word allows 63 grid columns; a larger gridSpan is a malformed file, and the colwidth array it would imply a memory risk. */
const MAX_SPAN = 63;
/** Tables inside tables inside tables... beyond this the table is kept whole as an opaque block (no stack overflow on a hostile file). */
const MAX_DEPTH = 10;

const ISSUE = {
  orphanMerge: 'A vertically merged table cell has no matching cell above it; it is shown as an ordinary cell. The original table is kept for export.',
  hiddenMergeContent: 'A cell inside a vertical merge holds content that Word does not show; it is shown as a separate cell so that nothing is lost. The original table is kept for export.',
  legacyMerge: 'A table uses the older horizontal merge (w:hMerge); its cells are shown separately. The original table is kept for export.',
  gridOffset: 'A table row starts after, or ends before, the table grid (w:gridBefore / w:gridAfter); the empty grid columns are not shown. The original table is kept for export.',
  spanClamped: 'A table cell spans more grid columns than Word allows; it is shown at the largest width. The original table is kept for export.',
  rowRevision: 'A tracked insertion or deletion of a whole table row is shown as an ordinary row. The original table is kept for export.',
  propertyRevision: 'Tracked changes to table or cell formatting are not shown or editable. The original table is kept for export.',
  rowException: 'A table row has its own table-property exceptions (w:tblPrEx), which are not shown. The original table is kept for export.',
  floating: 'A table positioned inside the text (a floating table) is shown as an ordinary block table. The original table is kept for export.',
  contentControl: 'A content control around table rows or cells is not kept as a unit; its content is shown. The original table is kept for export.',
  stray: 'Markup between table rows or cells (bookmarks, comment ranges, revision marks) is not shown in the table. The original table is kept for export.',
} as const;
type Issue = keyof typeof ISSUE;

const BORDERS = 'Table borders and shading are shown approximately. The original table formatting is kept for export.';
const KEPT_WHOLE_DEPTH = 'A table nested very deeply inside other tables is kept as a read-only block.';
const KEPT_WHOLE_ROWS = 'A table without rows is kept as a read-only block.';

/**
 * The children of a table or row with Google Docs wrappers unwrapped. A content control that Word wrote around rows or cells
 * cannot be an atom there (a row holds only cells), so its content is read in its place and the table says so.
 */
function structuralChildren(parent: Element, ctx: ReadContext, issues: Set<Issue>): Element[] {
  const out: Element[] = [];
  for (const el of blockChildren(parent, ctx)) {
    if (isW(el, 'sdt')) {
      issues.add('contentControl');
      const content = firstW(el, 'sdtContent');
      if (content) out.push(...structuralChildren(content, ctx, issues));
    } else out.push(el);
  }
  return out;
}

/** A paragraph with no text and nothing else of substance: no runs with content, no anchors, no revisions. */
function isBlankParagraph(p: Element): boolean {
  for (const c of childElements(p)) {
    if (isW(c, 'pPr') || isW(c, 'proofErr')) continue;
    if (isW(c, 'r') && childElements(c).every(x => isW(x, 'rPr') || isW(x, 'lastRenderedPageBreak'))) continue;
    return false;
  }
  return true;
}

/** Every child of the cell is a blank paragraph (or the cell's properties): the cell has nothing Word would show or a reader could lose. */
function isBlankCell(tc: Element): boolean {
  return childElements(tc).every(c => isW(c, 'tcPr') || (isW(c, 'p') && isBlankParagraph(c)));
}

interface Slot {
  tc: Element;
  /** First grid column the cell covers. */
  start: number;
  span: number;
  merge: 'restart' | 'continue' | null;
}

interface RowInfo {
  slots: Slot[];
  header: boolean;
}

function readRow(tr: Element, ctx: ReadContext, issues: Set<Issue>, borders: { seen: boolean }): RowInfo {
  let col = 0;
  let header = false;
  const trPr = firstW(tr, 'trPr');
  if (trPr) {
    for (const c of childElements(trPr)) {
      if (isW(c, 'tblHeader')) header = onOff(c);
      else if (isW(c, 'gridBefore')) {
        const n = int(wAttr(c, 'val')) ?? 0;
        if (n > 0) {
          col += Math.min(n, MAX_SPAN);
          issues.add('gridOffset');
        }
      } else if (isW(c, 'gridAfter')) {
        if ((int(wAttr(c, 'val')) ?? 0) > 0) issues.add('gridOffset');
      } else if (isW(c, 'ins') || isW(c, 'del')) issues.add('rowRevision');
      else if (isW(c, 'trPrChange')) issues.add('propertyRevision');
    }
  }
  const slots: Slot[] = [];
  for (const el of structuralChildren(tr, ctx, issues)) {
    if (isW(el, 'trPr')) continue;
    if (isW(el, 'tblPrEx')) {
      issues.add('rowException');
      continue;
    }
    if (!isW(el, 'tc')) {
      issues.add('stray');
      continue;
    }
    const tcPr = firstW(el, 'tcPr');
    let span = 1;
    let merge: Slot['merge'] = null;
    if (tcPr) {
      for (const c of childElements(tcPr)) {
        if (isW(c, 'gridSpan')) {
          const n = int(wAttr(c, 'val'));
          if (n !== undefined && n > 1) {
            span = Math.min(n, MAX_SPAN);
            if (n > MAX_SPAN) issues.add('spanClamped');
          }
        } else if (isW(c, 'vMerge')) merge = wAttr(c, 'val') === 'restart' ? 'restart' : 'continue';
        else if (isW(c, 'hMerge')) issues.add('legacyMerge');
        else if (isW(c, 'tcBorders') || isW(c, 'shd')) borders.seen = true;
        else if (isW(c, 'cellIns') || isW(c, 'cellDel') || isW(c, 'cellMerge') || isW(c, 'tcPrChange')) issues.add('propertyRevision');
      }
    }
    slots.push({ tc: el, start: col, span, merge });
    col += span;
  }
  return { slots, header };
}

interface BuiltCell {
  type: 'tableCell' | 'tableHeader';
  attrs: { colspan: number; rowspan: number; colwidth: number[] | null };
  content: JSONContent[];
}

/**
 * Withdraw what an abandoned table read added. O(1) to take: the report counts are small, the comment ids are restored by size, and
 * the block and fragment entries are removed by the ids this read asked `ctx.nextId` for (see `readTableAt`), never by scanning the
 * preservation maps, which would make a document with thousands of tables quadratic.
 */
function rollbackPoint(ctx: ReadContext, created: string[]): () => void {
  const counts = { ...ctx.report.counts };
  const byCategory = { ...ctx.report.byCategory };
  const warnings = ctx.report.warnings.length;
  const assets = ctx.assets.length;
  const restoreComments = snapshotCommentIds(ctx.report);
  return () => {
    for (const id of created) {
      delete ctx.preservation.blocks[id];
      delete ctx.preservation.fragments[id];
    }
    created.length = 0;
    ctx.report.counts = counts;
    ctx.report.byCategory = byCategory;
    ctx.report.warnings.length = warnings;
    dropAssetsAfter(ctx, assets); // the images of an abandoned table are in its fragment only, so their bytes are not imported either
    restoreComments();
  };
}

function keepWhole(tbl: Element, ctx: ReadContext, rollback: () => void, message: string): JSONContent {
  rollback();
  warnOnce(ctx.report, 'table', message, 3);
  return readOpaque(tbl, ctx, 'unknownField', 'table', { block: true });
}

/** The content of one cell: its paragraphs, tables and opaque blocks, with its lists grouped (per cell: numbering counts restart in each). */
function readCell(tc: Element, ctx: ReadContext, depth: number): JSONContent[] {
  const nodes: JSONContent[] = [];
  for (const el of blockChildren(tc, ctx)) {
    if (isW(el, 'tcPr')) continue;
    if (isW(el, 'p')) nodes.push(...[readParagraph(el, ctx)].flat());
    else if (isW(el, 'tbl')) nodes.push(readTableAt(el, ctx, depth + 1));
    else {
      const c = classifyOpaque(el);
      nodes.push(readOpaque(el, ctx, c.kind, c.label, { block: true }));
    }
  }
  const numbering = getNumbering(ctx);
  const grouped = groupListParagraphs(nodes.map(node => ({ node })), numbering, ctx);

  // Lists are grouped per cell, so a numbered list that carries on from an earlier cell (or from the text) starts again here.
  noteListCounts(ctx, 'cell', grouped, numbering);
  // A cell holds at least one block. A cell with no paragraph in the source (malformed) gets an empty one, which stands for nothing in the file.
  // WRITER (contract section 5.5, also in this file's header): the opposite case. A cell that ENDS with a nested table has no trailing
  // paragraph here, but Word requires a final `<w:p/>` in every `<w:tc>` (it is in the original fragment). When re-emitting such a
  // cell from the model, add an empty `<w:p/>` after the table.
  return grouped.length ? grouped : [{ type: 'paragraph' }];
}

function readTableAt(tbl: Element, ctx: ReadContext, depth: number): JSONContent {
  // Every id this read (and the tables nested in it) takes is logged, so an abandoned read can remove exactly its own entries.
  const ids = trackIds(ctx);
  try {
    return readTableBody(tbl, ctx, depth, rollbackPoint(ctx, ids.created));
  } finally {
    ids.stop();
  }
}

function readTableBody(tbl: Element, ctx: ReadContext, depth: number, rollback: () => void): JSONContent {
  if (depth >= MAX_DEPTH) return keepWhole(tbl, ctx, rollback, KEPT_WHOLE_DEPTH);

  const issues = new Set<Issue>();
  const borders = { seen: false };
  const rowEls: Element[] = [];
  let tblPr: Element | undefined;
  let gridEl: Element | undefined;
  for (const el of structuralChildren(tbl, ctx, issues)) {
    if (isW(el, 'tblPr')) tblPr ??= el;
    else if (isW(el, 'tblGrid')) gridEl ??= el;
    else if (isW(el, 'tr')) rowEls.push(el);
    else issues.add('stray');
  }
  if (!rowEls.length) return keepWhole(tbl, ctx, rollback, KEPT_WHOLE_ROWS);

  if (tblPr) {
    for (const c of childElements(tblPr)) {
      if (isW(c, 'tblBorders') || isW(c, 'shd')) borders.seen = true;
      else if (isW(c, 'tblpPr')) issues.add('floating');
      else if (isW(c, 'tblPrChange')) issues.add('propertyRevision');
    }
  }
  const gridPx: Array<number | undefined> = [];
  if (gridEl) {
    for (const c of childElements(gridEl)) {
      if (isW(c, 'gridCol')) {
        const w = int(wAttr(c, 'w'));
        gridPx.push(w !== undefined && w > 0 ? twipsToPx(w) : undefined);
      } else if (isW(c, 'tblGridChange')) issues.add('propertyRevision');
    }
  }
  const widthsOf = (start: number, span: number): number[] | null => {
    const out: number[] = [];
    for (let i = start; i < start + span; i++) {
      const w = gridPx[i];
      if (w === undefined) return null;
      out.push(w);
    }
    return out;
  };

  // Walk the rows once, by grid column, folding each vMerge continuation into the cell above it.
  const rows: JSONContent[] = [];
  const open = new Map<number, { cell: BuiltCell; span: number }>();
  let leadingHeader = true;
  for (const tr of rowEls) {
    const info = readRow(tr, ctx, issues, borders);
    leadingHeader = leadingHeader && info.header;
    const continued = new Set<number>();
    const cells: BuiltCell[] = [];
    for (const s of info.slots) {
      if (s.merge === 'continue') {
        const above = open.get(s.start);
        if (above && above.span === s.span && isBlankCell(s.tc)) {
          above.cell.attrs.rowspan += 1;
          continued.add(s.start);
          continue; // folded into the cell above: blank in the source, kept in the table's fragment
        }
        issues.add(isBlankCell(s.tc) ? 'orphanMerge' : 'hiddenMergeContent');
      }
      const cell: BuiltCell = {
        type: leadingHeader ? 'tableHeader' : 'tableCell',
        attrs: { colspan: s.span, rowspan: 1, colwidth: widthsOf(s.start, s.span) },
        content: readCell(s.tc, ctx, depth),
      };
      cells.push(cell);
      if (s.merge === 'restart') {
        open.set(s.start, { cell, span: s.span });
        continued.add(s.start);
      }
    }
    for (const k of [...open.keys()]) if (!continued.has(k)) open.delete(k);
    rows.push({ type: 'tableRow', content: cells as unknown as JSONContent[] });
  }

  let normalized: JSONContent;
  try {
    normalized = specNormalizeNode({ type: 'table', content: rows });
  } catch {
    // Not reachable for tables built here. If it ever is, nothing is lost: the table is kept whole, read-only.
    return keepWhole(tbl, ctx, rollback, 'A table could not be represented exactly; it is kept as a read-only block.');
  }
  const blockId = ctx.nextId();
  ctx.preservation.blocks[blockId] = captureFragment(tbl);

  recordFeature(ctx.report, 'table');
  const merged = rows.reduce((n, row) => n + (row.content as unknown as BuiltCell[]).filter(c => c.attrs.colspan > 1 || c.attrs.rowspan > 1).length, 0);
  recordFeature(ctx.report, 'mergedCell', merged);
  if (borders.seen) {
    recordFeature(ctx.report, 'tableBorders');
    warnOnce(ctx.report, 'tableBorders', BORDERS, 2);
  }
  for (const issue of issues) {
    recordFeature(ctx.report, 'tableLayout');
    warnOnce(ctx.report, 'tableLayout', ISSUE[issue], 2);
  }
  return stampProvenance(normalized, blockId);
}

/**
 * Read one `<w:tbl>` into a `table` node stamped with original-OOXML provenance. The table's source XML is kept in
 * `ctx.preservation.blocks[node.attrs.ooxml.blockId]`; see the file comment for what a writer needs.
 */
export function readTable(tbl: Element, ctx: ReadContext): JSONContent {
  return readTableAt(tbl, ctx, 0);
}

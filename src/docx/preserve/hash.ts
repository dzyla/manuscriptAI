import type { JSONContent } from '@tiptap/core';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function stripProvenance(node: JSONContent): JSONContent {
  const out: JSONContent = { ...node };
  if (node.attrs && 'ooxml' in node.attrs) {
    const { ooxml: _drop, ...rest } = node.attrs;
    out.attrs = rest;
  }
  // An image's `src` is a session blob: URL that `hydrateAssets` fills in when a document is opened (the stored node has none);
  // the picture is identified by `assetId`. Counting `src` would make every opened image look edited.
  if (node.type === 'resizableImage' && out.attrs && 'src' in out.attrs) {
    const { src: _src, ...rest } = out.attrs;
    out.attrs = rest;
  }
  if (node.content) out.content = node.content.map(stripProvenance);
  return out;
}

/** cyrb53: fast, synchronous 53-bit string hash (collision risk negligible per block). */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * The hash of a block as the editor holds it, ignoring only the provenance attribute itself (and an image's session `src`).
 *
 * *** FROZEN, AND THE MOST DANGEROUS THING IN THIS FILE. *** It covers EVERY attribute of the node and of every descendant. The
 * hash stored in `ooxml.sourceHash` (and in `lifted[].sourceHash`) was computed by this function over the node as it was READ. So
 * any attribute added to the schema later, to ANY node type, with ANY default, changes the hash of every stored block that has
 * that node type inside it, and `isBlockUntouched` then answers false for every imported paragraph at once. Nothing throws and
 * nothing is logged: every untouched paragraph silently becomes "edited", the writer regenerates the whole document from the model,
 * and the unmodelled paragraph properties, bookmarks and comment anchors that only the verbatim XML held are lost. The same applies
 * to changing this function, `stableStringify`, `cyrb53` or `stripProvenance`, and to changing the JSON a schema attribute's
 * default produces. Before changing any of them: version the hash (store the version beside `sourceHash`), or hash against an
 * allow-list of attributes, and re-stamp stored documents on migration. See docs/superpowers/specs/2026-10-07-a2b-writer-contract.md
 * section 2.
 */
export function blockHash(node: JSONContent): string {
  return cyrb53(stableStringify(stripProvenance(node)));
}

const STRUCTURAL = new Set(['table', 'tableRow', 'tableCell', 'tableHeader']);

/** The table's skeleton: rows, cells and their span/width/header attributes, with each cell's content reduced to its nested tables' skeletons. */
function skeleton(node: JSONContent): JSONContent {
  const out: JSONContent = { type: node.type };
  if (node.attrs) {
    const { ooxml: _drop, ...rest } = node.attrs;
    if (Object.keys(rest).length) out.attrs = rest;
  }
  const isCell = node.type === 'tableCell' || node.type === 'tableHeader';
  out.content = (node.content ?? []).filter(c => (isCell ? c.type === 'table' : STRUCTURAL.has(c.type ?? ''))).map(skeleton);
  return out;
}

/**
 * A second hash of a table that ignores what is IN its cells: the rows, the cells (colspan, rowspan, colwidth, header or not) and
 * any nested tables' skeletons count; every paragraph, list and opaque block in a cell does not. `blockHash` of a table changes
 * when one character in one cell changes, which says "the table was edited" but not "the table's shape was".
 *
 * WHAT IT MEANS, AND NOTHING MORE. The hash covers only the model-visible skeleton above. The shell (`tblPr`, `tblGrid`, each row's
 * `trPr`, each cell's `tcPr`: borders, shading, margins, row heights, the style) is NOT in the model, so the hash cannot see a
 * change to it; "equal hash means the shell is still valid" holds only because the app has no way to edit those properties. While
 * the hash equals the stored `ooxml.structureHash`, the original shell can be reused. The hash says nothing about where cell
 * CONTENT is: moving a paragraph to another cell, reordering a cell's blocks, swapping a nested table and a paragraph, swapping two
 * rows of identical shape, or replacing a cell's content with a list, all leave it unchanged. A writer that reuses the shell must
 * therefore rebuild EACH CELL'S BLOCK SEQUENCE from the model (by each block's `ooxml.blockId`, re-emitting an untouched block's
 * original XML), never patch "only the edited paragraphs" into the old cells. Because `tcPr` and `trPr` stay by POSITION, two
 * identical-shaped rows that swap move their content but not their formatting: a shaded totals row swapped with a plain row shows
 * the shading on the wrong row.
 *
 * WHAT IS NOT IN THE MODEL AT ALL, and so must come from the original `<w:tbl>` (`preservation.blocks[blockId]`, the source of the
 * row and cell sequence): (1) folded vMerge continuations. Each `<w:tc>` folded into a `rowspan` is blank and is not a model cell;
 * it exists only in the original XML, with its `tcPr` (vMerge, shading, borders). Re-emit the original `<w:tr>`/`<w:tc>` sequence
 * and re-insert each folded cell at its grid column, or the row and the grid fall out of alignment. (2) Rows with no model cells:
 * a `<w:tr>` whose cells were all folded (or that carried only `trPr`) is a model row with no cells; re-emit it from the original
 * XML. Nothing is lost in text, but the structure is, if the writer builds rows from model cells alone.
 *
 * WHEN THE HASH DIFFERS ("structure changed": a row or column was added or deleted, cells were merged or split, a header row
 * toggled; the editor's table menu offers add row above / below, add column before / after, delete row, delete column).
 * `isTableShellUnchanged` is false and the original `<w:tbl>` can no longer be re-emitted around the model: its row and cell
 * sequence, its `tblGrid`, and every positional `trPr` / `tcPr` describe a table that no longer exists, so "row i is the i-th
 * `<w:tr>`" is false and the folded vMerge cells below are in the wrong rows. The rule (also contract section 5.3):
 *   1. Build the `<w:tbl>` from the MODEL: rows from `tableRow`, cells from `tableCell` / `tableHeader` (`colspan` -> `gridSpan`,
 *      `rowspan` -> `vMerge` restart plus continuation cells, `colwidth` px x 15 -> `tcW` and `tblGrid`, header row -> `tblHeader`),
 *      each cell's blocks by `blockId` exactly as in the shell-reused case. The original XML is not walked row by row.
 *   2. Keep from the original what does not depend on rows or columns and the app cannot edit: `tblPr` whole (including a
 *      `tblPrChange`), and for a surviving cell its `tcPr` EXCEPT the structure properties the model regenerates (`gridSpan`,
 *      `vMerge`, `hMerge`, `tcW`), for a surviving row its `trPr` except `tblHeader`. Shading, borders, margins, alignment, row
 *      height AND the revision marks inside them (`cellIns`, `cellDel`, `cellMerge`, `tcPrChange`, `trPrChange`) travel with the cell
 *      or row. "Surviving" is by CONTENT identity: a model cell holding a block whose `blockId` is inside an original `<w:tc>`
 *      inherits that cell's properties (the first matched block claims it; the first model cell to claim an original cell keeps it).
 *      Never by position.
 *   3. A cell or row with no match (every one the author added, and every regenerated continuation cell) copies only the FORMATTING
 *      properties of a neighbour (shd, tcBorders, tcMar, vAlign, noWrap; trHeight, cantSplit), never revision marks. Neighbour: for an
 *      added row the nearest preceding matched row in the same grid column, else the nearest following; for an added column the
 *      matched cell beside it in the same row (left, else right); for both, the column neighbour. An approximation; the export should
 *      say the table's cell formatting was approximated.
 *   4. The folded vMerge continuation cells are REGENERATED from the model's `rowspan`s (a blank `<w:tc>` with `tcW`, `vMerge` and
 *      the restart cell's formatting properties), NOT re-inserted from the original: after a row is added inside a merged region the
 *      model's `rowspan` is larger than the original's, and a continuation exists with no original to copy. Rows with no model
 *      cells that the original carried (`trPr` only) survive only if their neighbours do; otherwise they are dropped with the
 *      structure, and nothing in the model is lost by that.
 *   5. Every `<w:tc>` ends in a `<w:p/>` (a cell that ends in a nested table gets one appended).
 *   6. `tblGrid` is rebuilt, so it can disagree with the kept `tblPr`: a `dxa` `tblW`, or a `fixed` `tblLayout`, is set to the rebuilt
 *      grid's sum; a `tblGridChange` is dropped with the old grid.
 *   7. The import headline counted the table-level revision marks (cellIns/cellDel/cellMerge as tracked changes, trPrChange /
 *      tcPrChange / tblPrChange / tblGridChange as formatting changes). Steps 2 and 6 carry all but `tblGridChange`; marks on removed
 *      rows or cells are lost with them. The export must warn with the number it could not carry.
 * What may NOT happen under any rule: a model block (a paragraph, list, image, nested table) disappears, a cell's content lands in
 * another cell, or the `<w:tbl>` is invalid (every row's `gridSpan` sum equals the grid width; a `vMerge` continuation sits under a
 * restart cell). Nothing of this is exercised until the writer exists; the rule is the contract for it.
 *
 * FROZEN once A2a ships. The format changed during development (round 1 omitted `content` for a cell without nested tables; round
 * 2 always sets it), and a stored `structureHash` is compared byte for byte, so any further change makes every stored table read as
 * "structure changed" and rebuilt without its original shell, again with no error. Version it before changing.
 */
export function structureHash(table: JSONContent): string {
  return cyrb53(stableStringify(skeleton(table)));
}

/** Attach provenance. `node` must already be schema-normalized (see normalizeDoc). A table also gets its `structureHash`. */
export function stampProvenance(node: JSONContent, blockId: string): JSONContent {
  const ooxml = { blockId, sourceHash: blockHash(node), ...(node.type === 'table' ? { structureHash: structureHash(node) } : {}) };
  return { ...node, attrs: { ...(node.attrs ?? {}), ooxml } };
}

export function isBlockUntouched(node: JSONContent): boolean {
  const p = node.attrs?.ooxml as { sourceHash?: string } | null | undefined;
  return !!p?.sourceHash && blockHash(node) === p.sourceHash;
}

/**
 * The table-level counterpart of `isBlockUntouched`: is the table's SHELL (its rows, cells, spans, widths and header cells) still the
 * one that was read? True means the original `<w:tbl>`'s `tblPr`, `tblGrid`, `trPr` and `tcPr` may be reused. It does NOT mean the
 * table is untouched (use `isBlockUntouched` for "re-emit the whole `<w:tbl>` verbatim"), and it does NOT mean the cells' content
 * is where it was: a writer that reuses the shell must still rebuild every cell's block sequence from the model (see
 * `structureHash`). False means "structure changed" (rebuild from the model, `structureHash` doc), and also for a table with no
 * stored `structureHash` (not stamped by `readDocx`; the conservative answer) and for anything that is not a table.
 * An untouched table always has an unchanged shell. Every writer calls this rather than comparing hashes itself.
 */
export function isTableShellUnchanged(node: JSONContent): boolean {
  if (node.type !== 'table') return false;
  const p = node.attrs?.ooxml as { structureHash?: string } | null | undefined;
  return !!p?.structureHash && structureHash(node) === p.structureHash;
}

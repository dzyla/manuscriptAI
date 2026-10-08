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
 * The hash format is not stable across builds (round 1 omitted `content` for a cell without nested tables; round 2 always sets it).
 * That is harmless only because nothing is persisted yet: a table stamped by an older build would read as "shape changed" and be
 * rebuilt without its original shell. Change the format again only before A2a ships, or version it.
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

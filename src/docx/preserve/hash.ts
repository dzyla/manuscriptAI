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
  const kids = (node.content ?? []).filter(c => (node.type === 'tableCell' || node.type === 'tableHeader' ? c.type === 'table' : STRUCTURAL.has(c.type ?? '')));
  if (kids.length || node.type === 'tableRow') out.content = kids.map(skeleton);
  return out;
}

/**
 * A second hash of a table that ignores what is IN its cells: the rows, the cells (colspan, rowspan, colwidth, header or not) and
 * any nested tables' skeletons count; every paragraph, list and opaque block in a cell does not. `blockHash` of a table changes
 * when one character in one cell changes, which says "the table was edited" but not "the table's shape was". When
 * `structureHash(table)` still equals the stored `ooxml.structureHash`, the original `<w:tbl>` shell (borders, shading, margins, row
 * heights, style) is still valid and a writer can patch the edited cell content into it, using each paragraph's own provenance.
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

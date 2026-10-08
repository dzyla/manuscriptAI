// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { stableStringify, blockHash, stampProvenance, isBlockUntouched, isTableShellUnchanged, structureHash } from './hash';
import { normalizeDoc, htmlToDoc, docToHtml } from '../../extensions/schema';

const para = (text: string): JSONContent =>
  normalizeDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }).content![0];

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('keeps array order', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });
});

describe('an image\'s src is not part of its hash', () => {
  it('opening a document fills in a session blob: URL as src; that is not an edit, but a different asset or size is', () => {
    const image = normalizeDoc({ type: 'doc', content: [{ type: 'resizableImage', attrs: { assetId: 'a_1', width: '50%' } }] }).content![0];
    const stamped = stampProvenance(image, 'b1');
    const hydrated = { ...stamped, attrs: { ...stamped.attrs, src: 'blob:http://localhost/abc' } };
    expect(isBlockUntouched(hydrated)).toBe(true);
    expect(isBlockUntouched({ ...stamped, attrs: { ...stamped.attrs, width: '60%' } })).toBe(false);
    expect(isBlockUntouched({ ...stamped, attrs: { ...stamped.attrs, assetId: 'a_2' } })).toBe(false);
    // other node types keep counting every attribute
    expect(blockHash({ type: 'paragraph', attrs: { src: 'x' } })).not.toBe(blockHash({ type: 'paragraph', attrs: { src: 'y' } }));
  });
});

describe('block provenance', () => {
  it('stamped block is untouched until its content changes', () => {
    const p = stampProvenance(para('hello'), 'b1');
    expect(p.attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: blockHash(p) });
    expect(isBlockUntouched(p)).toBe(true);
    const edited = { ...p, content: [{ type: 'text', text: 'hello!' }] };
    expect(isBlockUntouched(edited)).toBe(false);
  });

  it('hash ignores the ooxml attribute itself', () => {
    const p = para('x');
    expect(blockHash(stampProvenance(p, 'b9'))).toBe(blockHash(p));
  });

  it('a block without provenance is never untouched', () => {
    expect(isBlockUntouched(para('x'))).toBe(false);
  });

  it('survives an editor-style html round trip unchanged', () => {
    const p = stampProvenance(para('round trip'), 'b2');
    const doc: JSONContent = { type: 'doc', content: [p] };
    const back = htmlToDoc(docToHtml(doc));
    expect(back.content![0].attrs?.ooxml).toEqual(p.attrs?.ooxml);
    expect(isBlockUntouched(back.content![0])).toBe(true);
  });

  it('adding a mark makes the block touched', () => {
    const p = stampProvenance(para('mark me'), 'b3');
    const bolded = { ...p, content: [{ type: 'text', text: 'mark me', marks: [{ type: 'bold' }] }] };
    expect(isBlockUntouched(normalizeDoc({ type: 'doc', content: [bolded] }).content![0])).toBe(false);
  });

  it('malformed data-ooxml in HTML parses to null', () => {
    const doc = htmlToDoc('<p data-ooxml="{not json">x</p>');
    expect(doc.content![0].attrs?.ooxml ?? null).toBeNull();
  });
});

describe('structureHash', () => {
  const cell = (type: string, content: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
    content,
  });
  const text = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const table = (rows: JSONContent[][]): JSONContent => ({ type: 'table', content: rows.map(cells => ({ type: 'tableRow', content: cells })) });
  const base = () => table([[cell('tableHeader', [text('h')]), cell('tableHeader', [text('i')])], [cell('tableCell', [text('a')]), cell('tableCell', [text('b')])]]);

  it('ignores cell content (text, paragraph count, block types) and the provenance attribute', () => {
    const h = structureHash(base());
    const edited = base();
    edited.content![1].content![0].content = [text('changed'), text('another'), { type: 'bulletList', content: [] }];
    expect(structureHash(edited)).toBe(h);
    expect(structureHash(stampProvenance(base(), 'b1'))).toBe(h);
  });

  it('counts rows, cells, cell types and span / width attributes', () => {
    const h = structureHash(base());
    const more = base();
    more.content!.push(more.content![1]);
    expect(structureHash(more)).not.toBe(h);
    const fewer = base();
    fewer.content![1].content!.pop();
    expect(structureHash(fewer)).not.toBe(h);
    const span = base();
    span.content![1].content![0].attrs!.colspan = 2;
    expect(structureHash(span)).not.toBe(h);
    const kind = base();
    kind.content![1].content![0].type = 'tableHeader';
    expect(structureHash(kind)).not.toBe(h);
    const width = base();
    width.content![0].content![0].attrs!.colwidth = [120];
    expect(structureHash(width)).not.toBe(h);
  });

  it('includes the skeleton of a nested table, and a row with no cells differs from no row', () => {
    const nested = (rows: number): JSONContent => table([[cell('tableCell', [text('x'), table(Array.from({ length: rows }, () => [cell('tableCell', [text('y')])]))])]]);
    expect(structureHash(nested(1))).not.toBe(structureHash(nested(2)));
    expect(structureHash(table([[]]))).not.toBe(structureHash({ type: 'table', content: [] }));
  });

  it('is stored only on tables by stampProvenance and survives the HTML round trip', () => {
    const t = stampProvenance(base(), 't1');
    expect((t.attrs!.ooxml as { structureHash?: string }).structureHash).toBe(structureHash(base()));
    expect(stampProvenance(para('p'), 'p1').attrs!.ooxml).not.toHaveProperty('structureHash');
    const back = htmlToDoc(docToHtml({ type: 'doc', content: [t] }));
    expect(back.content![0].attrs?.ooxml).toEqual(t.attrs!.ooxml);
  });
});

describe('isTableShellUnchanged', () => {
  const cell = (content: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({
    type: 'tableCell',
    attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
    content,
  });
  const text = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });
  const base = (): JSONContent => ({ type: 'table', content: [row(cell([text('a')]), cell([text('b')])), row(cell([text('c')]), cell([text('d')]))] });
  // stampProvenance wants a schema-normalized node (the reader's own order of operations)
  const stamped = () => stampProvenance(normalizeDoc({ type: 'doc', content: [base()] }).content![0], 't1');

  it('is true for an untouched table, and for one whose cell text was edited (the shell still fits)', () => {
    const t = stamped();
    expect(isTableShellUnchanged(t)).toBe(true);
    expect(isBlockUntouched(t)).toBe(true);
    const edited = structuredClone(t);
    edited.content![0].content![0].content = [text('changed'), text('and another paragraph')];
    expect(isBlockUntouched(edited)).toBe(false); // the content moved ...
    expect(isTableShellUnchanged(edited)).toBe(true); // ... the shell did not
  });

  it('is false once a row or a column was added or deleted, or a cell was merged or split', () => {
    const addRow = structuredClone(stamped());
    addRow.content!.push(row(cell([text('')]), cell([text('')])));
    expect(isTableShellUnchanged(addRow)).toBe(false);
    const deleteRow = structuredClone(stamped());
    deleteRow.content!.pop();
    expect(isTableShellUnchanged(deleteRow)).toBe(false);
    const addColumn = structuredClone(stamped());
    for (const r of addColumn.content!) r.content!.push(cell([text('')]));
    expect(isTableShellUnchanged(addColumn)).toBe(false);
    const deleteColumn = structuredClone(stamped());
    for (const r of deleteColumn.content!) r.content!.pop();
    expect(isTableShellUnchanged(deleteColumn)).toBe(false);
    const merged = structuredClone(stamped());
    merged.content![0].content![0].attrs!.colspan = 2;
    merged.content![0].content!.pop();
    expect(isTableShellUnchanged(merged)).toBe(false);
  });

  it('is true for the rearrangements the hash cannot see (the writer must still rebuild each cell from the model)', () => {
    const swapped = structuredClone(stamped());
    swapped.content!.reverse(); // two rows of identical shape swapped
    expect(isTableShellUnchanged(swapped)).toBe(true);
    expect(isBlockUntouched(swapped)).toBe(false);
    const moved = structuredClone(stamped());
    const p = moved.content![0].content![0].content!.pop()!; // a paragraph moved between cells
    moved.content![0].content![1].content!.push(p);
    expect(isTableShellUnchanged(moved)).toBe(true);
  });

  it('is false for a table with no stored structureHash (an import that did not stamp one), and for a node that is not a table', () => {
    expect(isTableShellUnchanged(base())).toBe(false);
    expect(isTableShellUnchanged(stampProvenance(para('p'), 'p1'))).toBe(false);
    const noHash = structuredClone(stamped());
    delete (noHash.attrs!.ooxml as { structureHash?: string }).structureHash;
    expect(isTableShellUnchanged(noHash)).toBe(false);
  });

  it('mirrors isBlockUntouched: an untouched table always has an unchanged shell', () => {
    const t = stamped();
    expect(isBlockUntouched(t) && isTableShellUnchanged(t)).toBe(true);
  });
});

describe('FROZEN FORMATS (docs/superpowers/specs/2026-10-07-a2b-writer-contract.md section 2)', () => {
  /**
   * These literals are what `blockHash` / `structureHash` produced for each node type with the schema as it stood when A2a shipped.
   * `blockHash` covers EVERY attribute of a node, so if one of these fails you changed the schema (a new attribute on a block,
   * a changed default, a new mark attribute), the hash function, or `stableStringify`. Every `sourceHash` already stored in a user's
   * IndexedDB (and every `lifted[].sourceHash`, and every `structureHash`) was computed the old way: after your change
   * `isBlockUntouched` answers FALSE for every imported paragraph, nothing throws, and the writer regenerates the whole document
   * from the model, losing the unmodelled properties, bookmarks and comment anchors that only the original XML held.
   * Do NOT just update the literal. Version the hash (store a version beside `sourceHash`), or hash against an allow-list of
   * attributes, and re-stamp stored documents on migration. Then update this test.
   */
  const norm = (n: JSONContent): JSONContent => normalizeDoc({ type: 'doc', content: [n] }).content![0];
  const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });

  it('a normalized paragraph hashes as it did when A2a shipped', () => {
    expect(blockHash(norm({ type: 'paragraph', content: [text('Frozen.')] }))).toBe('0742f2c473be86');
  });

  it('a normalized heading with a mark', () => {
    expect(blockHash(norm({ type: 'heading', attrs: { level: 2 }, content: [text('Aims', [{ type: 'bold' }])] }))).toBe('198e214125c4ac');
  });

  it('a normalized image (its src is not counted)', () => {
    expect(blockHash(norm({ type: 'resizableImage', attrs: { assetId: 'a_1', width: '50%' } }))).toBe('1e03e8912f9a79');
  });

  it('a normalized table, and its structureHash', () => {
    const table = norm({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [text('c')] }] }] }] });
    expect(blockHash(table)).toBe('16cde321729c78');
    expect(structureHash(table)).toBe('020370c213ff29');
  });

  // MARKS ARE IN THE HASH TOO. Adding an attribute to a mark (for example the `highlight` mark, which the style audit will extend) changes
  // the JSON of every stored text node that carries it: r01 alone has 34 highlight marks in 22 paragraphs. This test is the one that
  // catches it, and its failure means exactly what the comment above says, not "update the expected attrs".
  it('a paragraph whose text carries highlight, link and fontSize marks', () => {
    const marks = [
      { type: 'highlight', attrs: { color: '#ffff00' } },
      { type: 'link', attrs: { href: 'https://example.org/' } },
      { type: 'fontSize', attrs: { sizePt: 14 } },
    ];
    expect(blockHash(norm({ type: 'paragraph', content: [text('Marked.', marks)] }))).toBe('12f73fdb675a26');
  });

  it('a bulletList / listItem / paragraph holding an opaqueInline (lists, items and atoms)', () => {
    const atom: JSONContent = { type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } };
    const list = norm({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('Item '), atom] }] }] });
    expect(blockHash(list)).toBe('0847fb83c2adcd');
  });

  it('the hash function itself, on a node that needs no schema', () => {
    expect(blockHash({ type: 'paragraph', content: [{ type: 'text', text: 'x' }] })).toBe('044d6fa92acbe6');
  });
});

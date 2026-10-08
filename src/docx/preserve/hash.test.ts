// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { stableStringify, blockHash, stampProvenance, isBlockUntouched, structureHash } from './hash';
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

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { stableStringify, blockHash, stampProvenance, isBlockUntouched } from './hash';
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

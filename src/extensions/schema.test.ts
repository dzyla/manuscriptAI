// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { htmlToDoc, docToHtml, normalizeDoc, isValidDoc, getDocSchema } from './schema';

const SAMPLE = [
  '<h2>Specific Aims</h2>',
  '<p style="text-align: justify">Text with <strong>bold</strong>, <em>italic</em>, <u>underline</u>, ',
  '<a href="https://example.org">a link</a> and a citation ',
  '<span data-citation-node="" data-source-ids="s1,s2" data-nums="1,2">[1,2]</span>.</p>',
  '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>',
  '<ol><li><p>first</p></li></ol>',
  '<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>c</p></td></tr></tbody></table>',
  '<blockquote><p>quote</p></blockquote>',
].join('');

describe('schema converters', () => {
  it('html → doc → html → doc is a fixed point', () => {
    const a = htmlToDoc(SAMPLE);
    const b = htmlToDoc(docToHtml(a));
    expect(b).toEqual(a);
  });

  it('keeps citation attributes', () => {
    const doc = htmlToDoc(SAMPLE);
    const json = JSON.stringify(doc);
    expect(json).toContain('"sourceIds":["s1","s2"]');
    expect(json).toContain('"nums":[1,2]');
  });

  it('keeps nested lists and table headers', () => {
    const doc = htmlToDoc(SAMPLE);
    const json = JSON.stringify(doc);
    expect(json).toContain('"tableHeader"');
    expect((json.match(/"bulletList"/g) ?? []).length).toBe(2);
  });

  it('normalizeDoc fills attribute defaults and is idempotent', () => {
    const raw = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
    const n = normalizeDoc(raw);
    expect(normalizeDoc(n)).toEqual(n);
    expect(n.content?.[0].attrs).toBeDefined();
  });

  it('isValidDoc rejects unknown node types and non-docs', () => {
    expect(isValidDoc({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    expect(isValidDoc({ type: 'doc', content: [{ type: 'hologram' }] })).toBe(false);
    expect(isValidDoc(null)).toBe(false);
    expect(isValidDoc({ type: 'paragraph' })).toBe(false);
  });

  it('schema contains the app node types', () => {
    const s = getDocSchema();
    for (const n of ['doc', 'paragraph', 'heading', 'table', 'citation', 'figureLabel', 'resizableImage'])
      expect(s.nodes[n], n).toBeDefined();
  });
});

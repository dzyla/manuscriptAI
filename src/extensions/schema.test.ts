// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { htmlToDoc, docToHtml, normalizeDoc, isValidDoc, getDocSchema, getSchemaExtensions } from './schema';

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

describe('node views', () => {
  it('are attached to exactly citation, figureLabel and resizableImage', () => {
    // A name drift between the VIEWS table in schema.ts and a spec's `name` would otherwise leave a
    // node silently without its view (or attach one to nothing).
    const withView = getSchemaExtensions()
      .filter(ext => typeof (ext as unknown as { config?: { addNodeView?: unknown } }).config?.addNodeView === 'function')
      .map(ext => (ext as { name?: string }).name)
      .sort();
    expect(withView).toEqual(['citation', 'figureLabel', 'resizableImage']);
  });
});

describe('DOCX paragraph and run formatting survives an HTML round trip', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2, styleId: 'heading2', textAlign: 'center', spaceBefore: 12, spaceAfter: 3.5, indentLeft: 0.5, indentFirstLine: -0.25, lineSpacing: { rule: 'atLeast', value: 14 } },
        content: [{ type: 'text', text: 'Title' }],
      },
      {
        type: 'paragraph',
        attrs: { styleId: 'normal', lineSpacing: { rule: 'auto', value: 1.5 }, indentFirstLine: 0.25 },
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'fontFamily', attrs: { family: 'Georgia' } }, { type: 'fontSize', attrs: { sizePt: 14 } }, { type: 'textColor', attrs: { color: '#ff0000' } }] },
          { type: 'text', text: 'b', marks: [{ type: 'superscript' }] },
          { type: 'text', text: 'c', marks: [{ type: 'subscript' }] },
          { type: 'text', text: 'd', marks: [{ type: 'characterStyle', attrs: { styleId: 'emphasis' } }] },
          { type: 'pageBreak' },
          { type: 'text', text: 'e' },
        ],
      },
    ],
  };

  it('every new attribute, mark and node is rendered to HTML and parsed back unchanged', () => {
    const once = normalizeDoc(doc);
    const back = htmlToDoc(docToHtml(once));
    expect(back).toEqual(once);
    // and the values really survived, not just defaulted on both sides
    const h = back.content![0];
    expect(h.attrs).toMatchObject({ styleId: 'heading2', spaceBefore: 12, spaceAfter: 3.5, indentLeft: 0.5, indentFirstLine: -0.25, lineSpacing: { rule: 'atLeast', value: 14 } });
    const p = back.content![1];
    expect(p.attrs).toMatchObject({ lineSpacing: { rule: 'auto', value: 1.5 }, indentFirstLine: 0.25 });
    expect(p.content!.map(c => c.type)).toEqual(['text', 'text', 'text', 'text', 'pageBreak', 'text']);
    expect(p.content![0].marks!.map(m => m.type).sort()).toEqual(['fontFamily', 'fontSize', 'textColor']);
    expect(p.content![0].marks!.find(m => m.type === 'fontSize')!.attrs).toEqual({ sizePt: 14 });
  });

  it('does not put an untrusted font name or colour into an inline style', () => {
    const html = docToHtml(normalizeDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'x', marks: [{ type: 'fontFamily', attrs: { family: 'a; background: url(//evil)' } }] },
        { type: 'text', text: 'y', marks: [{ type: 'textColor', attrs: { color: 'red; position: fixed' } }] },
      ] }],
    }));
    expect(html).not.toMatch(/style="[^"]*(url|position)/);
    expect(html).toContain('data-font-family');
  });
});

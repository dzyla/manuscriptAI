// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { htmlToDoc, docToHtml } from './schema';

const firstImage = (doc: JSONContent) => doc.content!.find(n => n.type === 'resizableImage')!;

describe('ResizableImage HTML round-trip', () => {
  it('preserves width, align and assetId through docToHtml/htmlToDoc', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'resizableImage', attrs: { src: 'x.png', assetId: 'a_1', alt: 'A', title: 'T', width: '50%', align: 'left' } }],
    };
    const out = firstImage(htmlToDoc(docToHtml(doc)));
    expect(out.attrs).toMatchObject({ src: 'x.png', assetId: 'a_1', width: '50%', align: 'left' });
  });

  it('round-trips the Word attributes the DOCX reader sets (placement, size, crop, the preserved run, the paragraph it was lifted from, provenance)', () => {
    const attrs = {
      src: 'x.png', assetId: 'a_1', width: '50%', align: 'right', wrap: 'right', widthIn: 3.25, heightIn: 2,
      crop: { l: 5.694, t: 3.516, r: 9.583, b: 57.032 }, fragmentId: 'b17', anchorBlockId: 'b16',
    };
    const doc: JSONContent = { type: 'doc', content: [{ type: 'resizableImage', attrs: { ...attrs, ooxml: { blockId: 'b9', sourceHash: 'abc' } } }] };
    expect(firstImage(htmlToDoc(docToHtml(doc))).attrs).toMatchObject({ ...attrs, ooxml: { blockId: 'b9', sourceHash: 'abc' } });
  });

  it('an image without Word attributes has none (null / empty), and a bogus wrap, crop or size is ignored', () => {
    expect(firstImage(htmlToDoc('<img src="x.png">')).attrs).toMatchObject({ wrap: null, widthIn: null, heightIn: null, crop: null, fragmentId: '', anchorBlockId: null });
    const bad = firstImage(htmlToDoc('<img src="x.png" data-wrap="diagonal" data-crop="{oops" data-width-in="wide">'));
    expect(bad.attrs).toMatchObject({ wrap: null, crop: null, widthIn: null });
  });

  it('reads legacy inline style width and data-align', () => {
    const out = firstImage(htmlToDoc('<img src="x.png" style="width:30%;margin-left:auto;margin-right:0" data-align="right">'));
    expect(out.attrs).toMatchObject({ width: '30%', align: 'right' });
  });

  it('falls back to defaults and the width attribute', () => {
    expect(firstImage(htmlToDoc('<img src="x.png">')).attrs).toMatchObject({ width: '100%', align: 'center' });
    expect(firstImage(htmlToDoc('<img src="x.png" width="200" data-align="bogus">')).attrs).toMatchObject({ width: '200', align: 'center' });
  });

  it('parses an image whose src was stripped but has an asset id', () => {
    const out = firstImage(htmlToDoc('<img data-asset-id="a_9">'));
    expect(out.attrs).toMatchObject({ assetId: 'a_9', src: null });
  });
});

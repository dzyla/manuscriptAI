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

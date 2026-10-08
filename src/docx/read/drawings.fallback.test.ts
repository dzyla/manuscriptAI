/**
 * The schema-failure paths of readTable and readParagraph with pictures in them. Both are "cannot happen" for nodes this reader
 * builds, so they are forced by making the schema's normalization throw. What an abandoned table read registered for its pictures
 * (their bytes, their fragments, their report counts) must be withdrawn with it; a paragraph that falls back keeps its pictures.
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import type { JSONContent } from '@tiptap/core';

let failTable = false;
let failParagraphText = ''; // fail the first paragraph with this text only (the fallback builds one with the same text)
vi.mock('../../extensions/schemaSpecs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../extensions/schemaSpecs')>();
  const text = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(text).join(''));
  return {
    ...actual,
    specNormalizeNode: (n: JSONContent) => {
      if (n.type === 'table' && failTable) throw new Error('forced');
      if (n.type === 'paragraph' && failParagraphText && text(n) === failParagraphText) {
        failParagraphText = '';
        throw new Error('forced');
      }
      return actual.specNormalizeNode(n as never);
    },
  };
});

const { openPackage } = await import('./package');
const { readStyles } = await import('./styles');
const { readBody } = await import('./body');
const { createReport } = await import('../fidelity');
const { emptyPreservationStore } = await import('../preserve/types');
const { collectFragmentIds } = await import('../preserve/refs');
const { collectAssetIds } = await import('../../db/assetStore');
const { isBlockUntouched } = await import('../preserve/hash');
const { W_NS } = await import('./ooxml');
const { mainDocumentPart } = await import('./opc');

const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WPNS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const ANS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PNS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const PNG_A = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const PNG_B = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const pic = (embed: string) =>
  `<w:r><w:drawing><wp:inline xmlns:wp="${WPNS}"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="x"/><a:graphic xmlns:a="${ANS}"><a:graphicData uri="${PNS}"><pic:pic xmlns:pic="${PNS}"><pic:nvPicPr><pic:cNvPr id="1" name="x"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embed}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const t = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;

async function read(bodyXml: string) {
  const zip = new JSZip();
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Type="${RNS}/image" Target="media/a.png"/><Relationship Id="rId11" Type="${RNS}/image" Target="media/b.png"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${W_NS}" xmlns:r="${RNS}"><w:body>${bodyXml}</w:body></w:document>`);
  zip.file('word/media/a.png', PNG_A);
  zip.file('word/media/b.png', PNG_B);
  const pkg = await openPackage(await zip.generateAsync({ type: 'arraybuffer' }));
  const report = createReport();
  let n = 0;
  const ctx = { pkg, styles: readStyles(pkg, report), report, preservation: emptyPreservationStore(), assets: [] as never[], nextId: () => `id${++n}` };
  const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(W_NS, 'body')[0];
  const result = await readBody(body, ctx as never);
  return { ctx, report, ...result, doc: { type: 'doc', content: result.blocks } as JSONContent };
}
const all = (nodes: JSONContent[], pred: (n: JSONContent) => boolean): JSONContent[] => {
  const out: JSONContent[] = [];
  const walk = (x: JSONContent): void => {
    if (pred(x)) out.push(x);
    (x.content ?? []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

describe('a table abandoned after its pictures were read', () => {
  const body = `<w:p>${pic('rId10')}</w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc><w:p>${t('in table')}${pic('rId11')}</w:p></w:tc></w:tr></w:tbl>`;

  it('control: with no failure both pictures are imported', async () => {
    failTable = false;
    const r = await read(body);
    expect(r.ctx.assets).toHaveLength(2);
    expect(r.report.counts.inlineImage).toBe(2);
  });

  it('the table\'s picture, its bytes, its fragment and its counts are withdrawn with it; the picture outside stays', async () => {
    failTable = true;
    try {
      const r = await read(body);
      expect(all(r.blocks, n => n.type === 'table')).toHaveLength(0);
      expect(all(r.blocks, n => n.type === 'opaqueBlock')).toHaveLength(1);
      expect(r.ctx.assets).toHaveLength(1);
      expect(r.report.counts.inlineImage).toBe(1);
      const imgs = all(r.blocks, n => n.type === 'resizableImage');
      expect(imgs).toHaveLength(1);
      expect(imgs[0].attrs!.assetId).toBe((r.ctx.assets[0] as { id: string }).id);
      expect([...collectAssetIds(r.doc)]).toEqual([(r.ctx.assets[0] as { id: string }).id]);
      // every fragment in the store is referenced: the abandoned picture's run left no orphan behind
      expect(Object.keys(r.ctx.preservation.fragments).sort()).toEqual([...collectFragmentIds(r.doc)].sort());
    } finally {
      failTable = false;
    }
  });
});

describe('a paragraph whose node cannot be normalized keeps its pictures', () => {
  it('the paragraph falls back to its text; the picture is still an image with its bytes, fragment and count', async () => {
    failParagraphText = 'fallback text';
    try {
      const r = await read(`<w:p>${t('fallback text')}${pic('rId10')}</w:p>`);
      expect(r.blocks.map(b => b.type)).toEqual(['resizableImage', 'paragraph']);
      expect(isBlockUntouched(r.blocks[1])).toBe(false); // no provenance: the degraded paragraph is regenerated
      expect(r.blocks[0].attrs!.anchorBlockId).toBeNull();
      expect(r.ctx.assets).toHaveLength(1);
      expect(r.report.counts.inlineImage).toBe(1);
      const f = r.blocks[0].attrs!.fragmentId as string;
      expect(r.ctx.preservation.fragments[f]).toBeDefined();
      expect(collectFragmentIds(r.doc).has(f)).toBe(true);
    } finally {
      failParagraphText = '';
    }
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import Dexie from 'dexie';
import { ManuscriptDb } from './manuscriptDb';
import { createDexieRepository, type LoadedDocument } from './documentRepository';
import { inlineAssetImages, dataUrlToBytes } from './assetStore';
import { htmlToDoc, isValidDoc, docToHtml } from '../extensions/schema';
import { createFormat } from '../services/formatPresets';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const mk = (html: string): LoadedDocument => ({
  title: 'T', saveState: 'Draft', docJson: htmlToDoc(html), format: createFormat('nih'), comments: [],
  citationRegistry: {}, citationCounter: 0, figureRegistry: {}, figureCounter: 0,
  mode: 'grant', grantInstructions: '', grantTemplateId: null,
});

let db: ManuscriptDb | null = null;
let name = '';
afterEach(async () => { db?.close(); if (name) await Dexie.delete(name); db = null; });

describe('C1: exported / snapshotted HTML is self-contained', () => {
  it('a reloaded document with an image exports data: URLs, never session blob: URLs', async () => {
    name = 't-inline-' + Math.random().toString(36).slice(2);
    db = new ManuscriptDb(name);
    const d = db;
    const repo = createDexieRepository(d, { htmlToDoc, isValidDoc, resolver: { urlFor: r => `blob:http://localhost/${r.id}` } });
    await repo.save(mk(`<p>fig</p><img src="${PNG}" alt="Figure 1">`));
    const html = docToHtml((await repo.load()).doc!.docJson);
    expect(html).toContain('blob:');
    const out = await inlineAssetImages(html, { getAsset: id => d.assets.get(id) });
    expect(out).toContain('src="data:image/png;base64,');
    expect(out).not.toContain('blob:');
    expect(out).toContain('alt="Figure 1"');
    // The inlined image round-trips to the same bytes.
    const src = out.match(/src="([^"]+)"/)![1];
    expect(new Uint8Array(dataUrlToBytes(src).data)).toEqual(new Uint8Array(dataUrlToBytes(PNG).data));
  });

  it('falls back to fetching a blob: URL that has no asset row', async () => {
    const fetchBytes = vi.fn().mockResolvedValue(dataUrlToBytes(PNG));
    const out = await inlineAssetImages('<p>x</p><img src="blob:http://localhost/abc">', { getAsset: async () => undefined, fetchBytes });
    expect(fetchBytes).toHaveBeenCalledWith('blob:http://localhost/abc');
    expect(out).toContain('src="data:image/png;base64,');
  });

  it('returns HTML without asset images unchanged (byte for byte)', async () => {
    const html = `<p>a &amp; b</p><img src="${PNG}"><img src="https://example.org/x.png">`;
    expect(await inlineAssetImages(html, { getAsset: async () => undefined })).toBe(html);
  });

  it('leaves an unresolvable image in place instead of failing', async () => {
    const html = '<p>x</p><img src="blob:http://localhost/dead">';
    const out = await inlineAssetImages(html, { getAsset: async () => undefined, fetchBytes: async () => { throw new Error('revoked'); } });
    expect(out).toContain('blob:http://localhost/dead');
  });
});

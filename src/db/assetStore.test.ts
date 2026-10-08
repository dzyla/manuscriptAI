import { describe, it, expect, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { prepareAssets, hydrateAssets, collectAssetIds, dataUrlToBytes, sha256Hex, assetIdFor, IMAGE_NODE } from './assetStore';
import type { AssetRow } from '../types';

// 1×1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const img = (src: string | null, assetId: string | null = null): JSONContent => ({ type: IMAGE_NODE, attrs: { src, assetId, alt: '', title: '', width: '100%', align: 'center' } });
const doc = (...nodes: JSONContent[]): JSONContent => ({ type: 'doc', content: nodes });

describe('asset store', () => {
  it('decodes data URLs', () => {
    const { mime, data } = dataUrlToBytes(PNG);
    expect(mime).toBe('image/png');
    expect(new Uint8Array(data).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // "PNG"
  });

  it('moves data-URL images into assets and strips src', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img(PNG)));
    expect(assets).toHaveLength(1);
    const a = assets[0];
    expect(a.id).toBe(assetIdFor(a.sha256));
    expect(a.mime).toBe('image/png');
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: a.id });
  });

  it('deduplicates identical images', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img(PNG), img(PNG)));
    expect(assets).toHaveLength(1);
    expect(out.content![0].attrs!.assetId).toBe(out.content![1].attrs!.assetId);
  });

  it('leaves http(s) images untouched', async () => {
    const { doc: out, assets } = await prepareAssets(doc(img('https://example.org/x.png')));
    expect(assets).toHaveLength(0);
    expect(out.content![0].attrs!.src).toBe('https://example.org/x.png');
  });

  it('strips blob: src when the asset id is already known', async () => {
    const { doc: out } = await prepareAssets(doc(img('blob:abc', 'a_known')));
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: 'a_known' });
  });

  it('fetches blob: src without asset id', async () => {
    const bytes = dataUrlToBytes(PNG);
    const fetchBytes = vi.fn().mockResolvedValue(bytes);
    const { assets } = await prepareAssets(doc(img('blob:xyz')), { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledWith('blob:xyz');
    expect(assets).toHaveLength(1);
  });

  it('hydrates asset ids back to URLs and marks missing ones', async () => {
    const { doc: stored, assets } = await prepareAssets(doc(img(PNG), img(null, 'a_missing')));
    const rows = new Map<string, AssetRow>(assets.map(a => [a.id, a]));
    const out = await hydrateAssets(stored, async id => rows.get(id), { urlFor: r => `url:${r.id}` });
    expect(out.content![0].attrs!.src).toBe(`url:${assets[0].id}`);
    expect(out.content![1].attrs).toMatchObject({ src: null, assetId: 'a_missing' });
  });

  it('hydrating a missing asset keeps the original alt text and asset id', async () => {
    const stored = doc({ type: IMAGE_NODE, attrs: { src: null, assetId: 'a_gone', alt: 'Figure 1: kinetics', title: '', width: '100%', align: 'center' } });
    const out = await hydrateAssets(stored, async () => undefined, { urlFor: r => `url:${r.id}` });
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: 'a_gone', alt: 'Figure 1: kinetics' });
  });

  it('re-ingests a live blob: src whose asset row no longer exists', async () => {
    const bytes = dataUrlToBytes(PNG);
    const id = assetIdFor(await sha256Hex(bytes.data));
    const fetchBytes = vi.fn().mockResolvedValue(bytes);
    const { doc: out, assets } = await prepareAssets(doc(img('blob:live', id)), { fetchBytes, existingAssetIds: new Set() });
    expect(fetchBytes).toHaveBeenCalledWith('blob:live');
    expect(assets.map(a => a.id)).toEqual([id]);
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: id });
  });

  it('still strips a blob: src whose asset row is known to exist', async () => {
    const fetchBytes = vi.fn();
    const { doc: out, assets } = await prepareAssets(doc(img('blob:abc', 'a_known')), { fetchBytes, existingAssetIds: new Set(['a_known']) });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(assets).toHaveLength(0);
    expect(out.content![0].attrs).toMatchObject({ src: null, assetId: 'a_known' });
  });

  describe('bad image sources never fail the whole save', () => {
    const BAD_B64 = 'data:image/png;base64,@@@notbase64';
    const SVG_UTF8 = 'data:image/svg+xml;utf8,<svg>100%</svg>';

    it('a malformed base64 data URL is left in place with a warning; other images still move', async () => {
      const { doc: out, assets, warnings } = await prepareAssets(doc(img(BAD_B64), img(PNG)));
      expect(out.content![0].attrs).toMatchObject({ src: BAD_B64, assetId: null });
      expect(assets).toHaveLength(1);
      expect(out.content![1].attrs!.src).toBeNull();
      expect(warnings).toHaveLength(1);
    });

    it('a non-base64 data URL with a bare % falls back to raw text bytes', async () => {
      const { mime, data } = dataUrlToBytes(SVG_UTF8);
      expect(mime).toBe('image/svg+xml');
      expect(new TextDecoder().decode(data)).toBe('<svg>100%</svg>');
      const { assets, warnings } = await prepareAssets(doc(img(SVG_UTF8)));
      expect(assets).toHaveLength(1);
      expect(warnings).toEqual([]);
    });

    it('percent-encoded non-base64 data URLs are still decoded', () => {
      expect(new TextDecoder().decode(dataUrlToBytes('data:text/plain,a%20b').data)).toBe('a b');
    });

    it('a failing fetch leaves the blob: node unchanged with a warning', async () => {
      const fetchBytes = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const { doc: out, assets, warnings } = await prepareAssets(doc(img('blob:dead')), { fetchBytes });
      expect(out.content![0].attrs).toMatchObject({ src: 'blob:dead', assetId: null });
      expect(assets).toHaveLength(0);
      expect(warnings).toHaveLength(1);
    });

    it('a non-ok response is not stored as image bytes', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })));
      try {
        const { doc: out, assets, warnings } = await prepareAssets(doc(img('blob:gone')));
        expect(assets).toHaveLength(0);
        expect(out.content![0].attrs!.src).toBe('blob:gone');
        expect(warnings).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('strips charset parameters from fetched content types', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8' } })));
      try {
        const { assets } = await prepareAssets(doc(img('blob:svg')));
        expect(assets[0].mime).toBe('image/svg+xml');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('collects asset ids at any depth', async () => {
    const nested = doc({ type: 'blockquote', content: [img(null, 'a_1')] }, img(null, 'a_2'));
    expect([...collectAssetIds(nested)].sort()).toEqual(['a_1', 'a_2']);
    expect(collectAssetIds(undefined).size).toBe(0);
  });

  it('sha256Hex is the standard digest', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

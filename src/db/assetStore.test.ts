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
    expect(out.content![1].attrs).toMatchObject({ src: null, alt: '[missing image]' });
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

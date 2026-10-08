import type { JSONContent } from '@tiptap/core';
import type { AssetRow } from '../types';

/** Registered name of the image node (must match ResizableImage's `name`). */
export const IMAGE_NODE = 'resizableImage';

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const assetIdFor = (sha: string) => 'a_' + sha.slice(0, 32);

export function dataUrlToBytes(url: string): { mime: string; data: ArrayBuffer } {
  const comma = url.indexOf(',');
  const header = url.slice(5, comma); // after "data:"
  const mime = header.split(';')[0] || 'application/octet-stream';
  const payload = url.slice(comma + 1);
  if (header.includes(';base64')) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, data: bytes.buffer };
  }
  return { mime, data: new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer };
}

async function defaultFetchBytes(url: string): Promise<{ mime: string; data: ArrayBuffer }> {
  const res = await fetch(url);
  return { mime: res.headers.get('content-type') ?? 'application/octet-stream', data: await res.arrayBuffer() };
}

function mapImages(doc: JSONContent, fn: (n: JSONContent) => JSONContent): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const next = n.type === IMAGE_NODE ? fn(n) : n;
    return next.content ? { ...next, content: next.content.map(walk) } : next;
  };
  return walk(doc);
}

function forEachImage(doc: JSONContent | undefined, fn: (n: JSONContent) => void): void {
  if (!doc) return;
  if (doc.type === IMAGE_NODE) fn(doc);
  doc.content?.forEach(c => forEachImage(c, fn));
}

/**
 * Move embedded image bytes out of the document into asset rows (spec §2.3).
 * Pure apart from hashing/fetching: does not touch IndexedDB, so it can run before a Dexie transaction.
 */
export async function prepareAssets(
  doc: JSONContent,
  opts: { fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }> } = {},
): Promise<{ doc: JSONContent; assets: AssetRow[] }> {
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const assets = new Map<string, AssetRow>();
  const bySrc = new Map<string, string>(); // src → asset id
  const pending: string[] = [];
  forEachImage(doc, n => {
    const src = n.attrs?.src as string | null;
    if (!src) return;
    if (src.startsWith('data:') || (src.startsWith('blob:') && !n.attrs?.assetId)) pending.push(src);
  });
  for (const src of new Set(pending)) {
    const { mime, data } = src.startsWith('data:') ? dataUrlToBytes(src) : await fetchBytes(src);
    const sha = await sha256Hex(data);
    const id = assetIdFor(sha);
    bySrc.set(src, id);
    if (!assets.has(id)) assets.set(id, { id, sha256: sha, mime, size: data.byteLength, data, createdAt: Date.now() });
  }
  const out = mapImages(doc, n => {
    const src = n.attrs?.src as string | null;
    if (src && bySrc.has(src)) return { ...n, attrs: { ...n.attrs, src: null, assetId: bySrc.get(src) } };
    if (src?.startsWith('blob:') && n.attrs?.assetId) return { ...n, attrs: { ...n.attrs, src: null } };
    return n;
  });
  return { doc: out, assets: [...assets.values()] };
}

export interface AssetUrlResolver {
  urlFor(row: AssetRow): string;
}

const urlCache = new Map<string, string>();
export const objectUrlResolver: AssetUrlResolver = {
  urlFor(row) {
    let url = urlCache.get(row.id);
    if (!url) {
      url = URL.createObjectURL(new Blob([row.data], { type: row.mime }));
      urlCache.set(row.id, url);
    }
    return url;
  },
};

export async function hydrateAssets(
  doc: JSONContent,
  getAsset: (id: string) => Promise<AssetRow | undefined>,
  resolver: AssetUrlResolver = objectUrlResolver,
): Promise<JSONContent> {
  const ids = collectAssetIds(doc);
  const urls = new Map<string, string | null>();
  for (const id of ids) {
    const row = await getAsset(id);
    urls.set(id, row ? resolver.urlFor(row) : null);
  }
  return mapImages(doc, n => {
    const id = n.attrs?.assetId as string | null;
    if (!id) return n;
    const url = urls.get(id);
    return url ? { ...n, attrs: { ...n.attrs, src: url } } : { ...n, attrs: { ...n.attrs, src: null, alt: '[missing image]' } };
  });
}

export function collectAssetIds(doc: JSONContent | undefined): Set<string> {
  const ids = new Set<string>();
  forEachImage(doc, n => { if (typeof n.attrs?.assetId === 'string') ids.add(n.attrs.assetId); });
  return ids;
}

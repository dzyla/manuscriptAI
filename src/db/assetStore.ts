import type { JSONContent } from '@tiptap/core';
import type { AssetRow } from '../types';
import { db as defaultDb } from './manuscriptDb';
import { sha256Hex, assetIdFor } from './assetHash';

export { sha256Hex, assetIdFor };

/** Registered name of the image node (must match ResizableImage's `name`). */
export const IMAGE_NODE = 'resizableImage';

/** Decode a data: URL. Throws on input that cannot be decoded (callers catch per image). */
export function dataUrlToBytes(url: string): { mime: string; data: ArrayBuffer } {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) throw new Error('Not a data: URL');
  const header = url.slice(5, comma); // after "data:"
  const mime = header.split(';')[0].trim() || 'application/octet-stream';
  const payload = url.slice(comma + 1);
  if (header.split(';').some(p => p.trim().toLowerCase() === 'base64')) {
    const bin = atob(payload.replace(/\s+/g, '')); // throws on malformed base64
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, data: bytes.buffer };
  }
  // Non-base64 (e.g. `;utf8,` SVG): percent-decode when valid, otherwise keep the raw text
  // (`<svg>100%</svg>` is a common hand-written form that decodeURIComponent rejects).
  let text: string;
  try {
    text = decodeURIComponent(payload);
  } catch {
    text = payload;
  }
  return { mime, data: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

/** Encode bytes as a self-contained data: URL. */
export function bytesToDataUrl(mime: string, data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export async function defaultFetchBytes(url: string): Promise<{ mime: string; data: ArrayBuffer }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetching ${url.slice(0, 64)} failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type');
  return { mime: type?.split(';')[0].trim() || 'application/octet-stream', data: await res.arrayBuffer() };
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
 *
 * `existingAssetIds`: asset ids known to have a stored row. A node whose assetId is NOT in this set
 * but which still carries a live blob:/data: src (undo history, clipboard) has its bytes re-ingested
 * instead of being stripped to a dangling reference. When omitted, every assetId is assumed to exist.
 *
 * Never throws for a single bad image: that node is left unchanged and a warning is returned.
 */
export async function prepareAssets(
  doc: JSONContent,
  opts: {
    fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
    existingAssetIds?: ReadonlySet<string>;
  } = {},
): Promise<{ doc: JSONContent; assets: AssetRow[]; warnings: string[] }> {
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const known = (id: unknown) => typeof id === 'string' && (!opts.existingAssetIds || opts.existingAssetIds.has(id));
  const assets = new Map<string, AssetRow>();
  const bySrc = new Map<string, string>(); // src → asset id
  const warnings: string[] = [];
  const pending: string[] = [];
  forEachImage(doc, n => {
    const src = n.attrs?.src as string | null;
    if (!src) return;
    if (src.startsWith('data:') || (src.startsWith('blob:') && !known(n.attrs?.assetId))) pending.push(src);
  });
  for (const src of new Set(pending)) {
    try {
      const { mime, data } = src.startsWith('data:') ? dataUrlToBytes(src) : await fetchBytes(src);
      const sha = await sha256Hex(data);
      const id = assetIdFor(sha);
      bySrc.set(src, id);
      if (!assets.has(id)) assets.set(id, { id, sha256: sha, mime, size: data.byteLength, data, createdAt: Date.now() });
    } catch (err) {
      warnings.push(`Image kept inline (could not be stored as an asset): ${src.slice(0, 48)}… — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const out = mapImages(doc, n => {
    const src = n.attrs?.src as string | null;
    if (src && bySrc.has(src)) return { ...n, attrs: { ...n.attrs, src: null, assetId: bySrc.get(src) } };
    if (src?.startsWith('blob:') && known(n.attrs?.assetId)) return { ...n, attrs: { ...n.attrs, src: null } };
    return n;
  });
  return { doc: out, assets: [...assets.values()], warnings };
}

export interface AssetUrlResolver {
  urlFor(row: AssetRow): string;
}

const urlCache = new Map<string, string>();

/**
 * Asset ids that have a session object URL (the editor, undo history or clipboard may hold it).
 * Garbage collection must never delete these: the bytes could come back on undo/paste.
 */
export function liveAssetIds(): string[] {
  return [...urlCache.keys()];
}
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
    // Missing bytes: keep the assetId and the author's alt text untouched (the node view renders a
    // placeholder); never write a substitute alt that a later save would persist.
    return url ? { ...n, attrs: { ...n.attrs, src: url } } : { ...n, attrs: { ...n.attrs, src: null } };
  });
}

export function collectAssetIds(doc: JSONContent | undefined): Set<string> {
  const ids = new Set<string>();
  forEachImage(doc, n => { if (typeof n.attrs?.assetId === 'string') ids.add(n.attrs.assetId); });
  return ids;
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** True when some <img> in the HTML depends on session state (blob: URL or asset id without inline bytes). */
function needsInlining(html: string): boolean {
  for (const [tag] of html.matchAll(IMG_TAG)) {
    const m = tag.match(SRC_ATTR);
    const src = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    if (src.startsWith('data:')) continue;
    if (src.startsWith('blob:') || /\bdata-asset-id\s*=/i.test(tag)) return true;
  }
  return false;
}

/**
 * Make HTML self-contained: every asset-backed or blob: image gets its bytes inlined as a data: URL.
 * Use for anything that outlives the session (workspace export, Markdown export, version snapshots,
 * persisted suggestion history). HTML that needs no change is returned unchanged; an image whose bytes
 * cannot be found is left as it was.
 */
export async function inlineAssetImages(
  html: string,
  opts: {
    getAsset?: (id: string) => Promise<AssetRow | undefined>;
    fetchBytes?: (url: string) => Promise<{ mime: string; data: ArrayBuffer }>;
  } = {},
): Promise<string> {
  if (!html || !needsInlining(html)) return html;
  const getAsset = opts.getAsset ?? ((id: string) => defaultDb.assets.get(id));
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  for (const img of Array.from(parsed.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:')) continue;
    const id = img.getAttribute('data-asset-id');
    if (!id && !src.startsWith('blob:')) continue;
    try {
      let bytes: { mime: string; data: ArrayBuffer } | null = null;
      if (id) {
        const row = await getAsset(id);
        if (row) bytes = { mime: row.mime, data: row.data };
      }
      if (!bytes && src.startsWith('blob:')) bytes = await fetchBytes(src);
      if (!bytes) continue;
      img.setAttribute('src', bytesToDataUrl(bytes.mime, bytes.data));
      changed = true;
    } catch {
      // Leave this image as it is; one unreadable image must not block the export.
    }
  }
  return changed ? parsed.body.innerHTML : html;
}

/**
 * Drop the bytes of asset-backed images: `src` is removed from every `<img data-asset-id>` (the id stays,
 * so the image can be re-resolved while the asset still exists). Images without an asset id keep their
 * `src` because nothing else can recover them. HTML with nothing to strip is returned unchanged.
 */
export function stripAssetImageData(html: string): string {
  if (!html || !html.includes('data-asset-id')) return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  for (const img of Array.from(parsed.querySelectorAll('img[data-asset-id]'))) {
    if (img.hasAttribute('src')) {
      img.removeAttribute('src');
      changed = true;
    }
  }
  return changed ? parsed.body.innerHTML : html;
}

/**
 * w:drawing -> an image node plus the image's bytes as an asset, and the pairing of figures with their captions.
 *
 * Images are exactly the parts most likely to be large (and so deferred by the package, see package.ts), and hashing them is
 * asynchronous, while the body reader is synchronous. So the work is split: `prepareMedia` (async) finds every image the body
 * refers to, reads its bytes, detects its real type and hashes it; `readDrawing` (sync) then only looks the result up.
 * Without `prepareMedia` a drawing is kept as the opaque atom it always was.
 *
 * WHAT A WRITER NEEDS TO RECONSTRUCT A DRAWING. An image node (`resizableImage`) holds what the editor can show and change
 * (`assetId` = the bytes, `width`/`widthIn`/`heightIn` = the size, `wrap` + `align` = where it sits, `alt`, `title`, `crop`).
 * Everything else is in the original XML, never in the model:
 *   - `attrs.fragmentId` -> `preservation.fragments[id]`: the `<w:r>` the drawing was read from, holding only its `<w:rPr>` and the
 *     whole `<w:drawing>` (the `wp:inline` or `wp:anchor` with its position, wrap distances, effect extent, `a:srcRect` crop, effects,
 *     `docPr` ids, and the `r:embed` / `r:link` relationship id, listed in the fragment's `relIds`). Change the size by patching
 *     `wp:extent` (and `a:ext` under `pic:spPr`) of that drawing, never by rebuilding it.
 *   - `attrs.ooxml` (present when the image stands for a WHOLE paragraph: a figure on its line of its own): `blockId` ->
 *     `preservation.blocks[id]`, the original `<w:p>`. While the node is untouched (`isBlockUntouched`) re-emit that paragraph
 *     verbatim. Once edited, rebuild the paragraph from this `<w:p>`'s `<w:pPr>` and the fragment's run.
 *   - `attrs.anchorBlockId` (present when the picture was lifted OUT of a paragraph that has other content, typically a floating
 *     picture anchored in a paragraph of text): the `ooxml.blockId` of that paragraph. The image node comes immediately before it.
 *     That paragraph's original XML STILL CONTAINS the drawing, and the paragraph node does not. While the paragraph is untouched
 *     it is re-emitted verbatim and the image must NOT be emitted again. It may be re-emitted verbatim only if every image node
 *     naming it in `anchorBlockId` is still in the document: when the author deleted the image, the anchor must be removed from the
 *     paragraph's XML. When the paragraph is edited (so rebuilt), put each surviving image's fragment run back into it.
 *   - The bytes: `assets[]` of the import (the same `AssetDraft` ids the nodes carry); the package's own copy stays in `pkg`.
 *   - An external (`r:link`) picture is a placeholder node (`src` and `assetId` null). Nothing is fetched; the link is in the
 *     fragment and in `preservation.rels`.
 * What cannot become an image node (relationship missing or dangling, the part absent, empty, too large, or in a format a
 * browser cannot show, a chart, SmartArt, a shape) is NOT dropped: `readDrawing` returns null and the caller keeps the drawing as
 * an opaque atom (a `unknownField` / "drawing" chip) with its XML in the fragment store.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature } from '../fidelity';
import { assetIdFor, sha256Hex } from '../../db/assetHash';
import { REL_NS, type PackageRel } from '../preserve/types';
import { captureFragment, captureShell } from '../preserve/xml';
import { DocxOpenError } from './package';
import { warnOnce, type AssetDraft, type ReadContext } from './context';
import { childElements, firstW, round4 } from './ooxml';
import { mainDocumentPart, resolveRelTarget } from './opc';
import { emuToIn } from './units';

export type { AssetDraft } from './context';

const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const PICTURE_URI = PIC_NS;
/** The width of a US Letter text area with 1 in margins, used when the page setup is not known. */
const DEFAULT_CONTENT_WIDTH_IN = 6.5;
/** Pictures beyond this many inches are a malformed or hostile `wp:extent`; their size is not trusted. */
const MAX_SIZE_IN = 200;

// ─── media ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type MediaFailure =
  | 'missing-rel' // the relationship id is not in the document's relationships
  | 'not-image' // it names something that is not an image relationship
  | 'unsafe' // its target is not a plain internal part name
  | 'absent' // the part is not in the package
  | 'empty' // zero bytes
  | 'too-large' // deferred and beyond the on-demand read limit
  | 'unsupported' // bytes in a format a browser cannot show (EMF, WMF, TIFF, anything unrecognised)
  | 'unreadable' // the relationships (or the part) could not be read
  | 'external'; // TargetMode="External": recorded, never fetched

export type MediaLookup =
  | { ok: true; part: string; mime: string; data: ArrayBuffer; sha256: string; id: string }
  | { ok: false; reason: MediaFailure; target?: string };

export interface MediaIndex {
  /** Every relationship id used by an `a:blip` in the body (embed or link), by id. */
  byRel: Map<string, MediaLookup>;
}

/** Formats a browser (and so the editor) shows. SVG is one of them; see `SVG_NOTE`. */
const DISPLAYABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml']);

function startsWith(b: Uint8Array, at: number, ...v: number[]): boolean {
  return b.length >= at + v.length && v.every((x, i) => b[at + i] === x);
}

/** The real type of an image from its first bytes. The declared content type is not trusted: a `.png` can hold a JPEG. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  if (startsWith(b, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(b, 0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(b, 0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(b, 0, 0x52, 0x49, 0x46, 0x46) && startsWith(b, 8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (startsWith(b, 0, 0x42, 0x4d) && b.length >= 26 && startsWith(b, 6, 0, 0, 0, 0)) return 'image/bmp';
  if (startsWith(b, 0, 0x49, 0x49, 0x2a, 0x00) || startsWith(b, 0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (startsWith(b, 0, 0x01, 0x00, 0x00, 0x00) && startsWith(b, 40, 0x20, 0x45, 0x4d, 0x46)) return 'image/emf';
  if (startsWith(b, 0, 0xd7, 0xcd, 0xc6, 0x9a) || startsWith(b, 0, 0x01, 0x00, 0x09, 0x00) || startsWith(b, 0, 0x02, 0x00, 0x09, 0x00)) return 'image/wmf';
  let head = '';
  for (let i = 0; i < Math.min(b.length, 1024); i++) head += String.fromCharCode(b[i]);
  if (/^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

async function loadPart(part: string, ctx: ReadContext): Promise<MediaLookup> {
  try {
    const bytes = ctx.pkg.isDeferred(part) ? await ctx.pkg.bytesAsync(part) : ctx.pkg.bytes(part);
    if (!bytes) return { ok: false, reason: 'absent' };
    if (bytes.length === 0) return { ok: false, reason: 'empty' };
    const mime = sniffImageMime(bytes);
    if (!mime || !DISPLAYABLE.has(mime)) return { ok: false, reason: 'unsupported' };
    const data = bytes.slice().buffer as ArrayBuffer; // a copy: the package's bytes are shared and must not be mutated
    const sha256 = await sha256Hex(data);
    return { ok: true, part, mime, data, sha256, id: assetIdFor(sha256) };
  } catch (e) {
    return { ok: false, reason: e instanceof DocxOpenError && e.code === 'too-large' ? 'too-large' : 'unreadable' };
  }
}

/**
 * Find, read and hash every image the body (`root`) refers to, and make them available to `readDrawing` through `ctx.media`.
 * One failing image never fails the others, nor the import. External relationships are looked at only as relationships: no
 * request is ever made. An id used by many drawings, and many ids naming one part, are each loaded once.
 */
export async function prepareMedia(ctx: ReadContext, root: Element): Promise<void> {
  const ids = new Set<string>();
  for (const blip of Array.from(root.getElementsByTagNameNS(A_NS, 'blip'))) {
    for (const attr of ['embed', 'link']) {
      const v = blip.getAttributeNS(REL_NS, attr);
      if (v) ids.add(v);
    }
  }
  const byRel = new Map<string, MediaLookup>();
  ctx.media = { byRel };
  if (!ids.size) return;

  const main = mainDocumentPart(ctx.pkg);
  let rels: Map<string, PackageRel> | null = null;
  try {
    rels = ctx.pkg.rels(main);
  } catch {
    rels = null;
  }
  const parts = new Map<string, Promise<MediaLookup>>();
  for (const id of ids) {
    const rel = rels?.get(id);
    if (!rels) byRel.set(id, { ok: false, reason: 'unreadable' });
    else if (!rel) byRel.set(id, { ok: false, reason: 'missing-rel' });
    else if (rel.targetMode === 'External') byRel.set(id, { ok: false, reason: 'external', target: rel.target });
    else if (!rel.type.endsWith('/image')) byRel.set(id, { ok: false, reason: 'not-image' });
    else {
      const part = resolveRelTarget(main, rel.target);
      if (part === undefined) byRel.set(id, { ok: false, reason: 'unsafe' });
      else {
        if (!parts.has(part)) parts.set(part, loadPart(part, ctx));
        byRel.set(id, await parts.get(part)!);
      }
    }
  }
}

const FAILURE_MESSAGE: Record<Exclude<MediaFailure, 'external'>, string> = {
  'missing-rel': 'An image refers to a relationship the document does not contain; it is kept as a read-only piece.',
  'not-image': 'An image refers to something that is not an image; it is kept as a read-only piece.',
  unsafe: 'An image refers to a location outside the document; it is kept as a read-only piece and was not read.',
  absent: 'An image refers to a file the document does not contain; it is kept as a read-only piece.',
  empty: 'An image file in the document is empty; it is kept as a read-only piece.',
  'too-large': 'An image is too large to import; it is kept as a read-only piece.',
  unsupported: 'An image is in a format the editor cannot show (such as EMF, WMF or TIFF); it is kept as a read-only piece.',
  unreadable: 'The relationships of the document could not be read, so images were kept as read-only pieces.',
};
const LINKED_IMAGE = 'A picture linked from another location (not stored in the document) is shown as an empty placeholder; nothing is downloaded. The link is kept for export.';
const SVG_NOTE = 'An SVG image is shown, but it cannot be analysed with AI or written to Word as-is; convert it to PNG or JPEG for that.';
const CROPPED = 'A cropped picture is shown whole (its crop is kept for export).';
const FLOATING_OTHER =
  'A picture placed behind or in front of the text, with text above and below it, or centred on the page is shown on a line of its own. Its original placement is kept for export.';
const NO_SIZE = 'A picture with no size is shown at the full width of the page.';

// ─── assets ──────────────────────────────────────────────────────────────────────────────────────────────────────

const knownAssets = new WeakMap<ReadContext, { ids: Set<string>; length: number }>();

function assetIds(ctx: ReadContext): Set<string> {
  let entry = knownAssets.get(ctx);
  if (!entry || entry.length !== ctx.assets.length) {
    entry = { ids: new Set(ctx.assets.map(a => a.id)), length: ctx.assets.length };
    knownAssets.set(ctx, entry);
  }
  return entry.ids;
}

/** Add an image's bytes once, however many drawings use them (the store is content-addressed). */
function registerAsset(ctx: ReadContext, m: Extract<MediaLookup, { ok: true }>): void {
  const ids = assetIds(ctx);
  if (ids.has(m.id)) return;
  const draft: AssetDraft = { id: m.id, mime: m.mime, data: m.data, sha256: m.sha256 };
  ctx.assets.push(draft);
  ids.add(m.id);
  knownAssets.get(ctx)!.length = ctx.assets.length;
}

/** Forget the assets added after the first `length` (an abandoned table or paragraph read withdraws its images' bytes too). */
export function dropAssetsAfter(ctx: ReadContext, length: number): void {
  if (ctx.assets.length > length) ctx.assets.length = length;
  knownAssets.delete(ctx);
}

// ─── drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const wp = (parent: Element, local: string): Element | undefined =>
  childElements(parent).find(c => c.namespaceURI === WP_NS && c.localName === local);

export type Wrap = 'square' | 'tight' | 'topAndBottom' | 'behind' | 'inFront' | 'none';

/** How text flows around an anchored drawing (its `wp:wrap*` child; `wrapNone` is behind or in front by `behindDoc`). */
export function classifyWrap(anchor: Element): Wrap {
  for (const c of childElements(anchor)) {
    if (c.namespaceURI !== WP_NS) continue;
    switch (c.localName) {
      case 'wrapSquare': return 'square';
      case 'wrapTight':
      case 'wrapThrough': return 'tight';
      case 'wrapTopAndBottom': return 'topAndBottom';
      case 'wrapNone': return /^(1|true)$/i.test(anchor.getAttribute('behindDoc') ?? '') ? 'behind' : 'inFront';
      default: break;
    }
  }
  return 'none';
}

/** Which side a floated picture sits on, from its horizontal position; null when it is centred or its position cannot say. */
function floatSide(anchor: Element, widthIn: number | null, contentWidthIn: number): 'left' | 'right' | null {
  const posH = wp(anchor, 'positionH');
  if (!posH) return null;
  const align = wp(posH, 'align')?.textContent?.trim().toLowerCase();
  if (align === 'left' || align === 'inside') return 'left';
  if (align === 'right' || align === 'outside') return 'right';
  if (align) return null; // centre
  const offset = Number(wp(posH, 'posOffset')?.textContent?.trim());
  if (!Number.isFinite(offset) || widthIn === null) return null;
  // Approximation: every `relativeFrom` is read as relative to the text column. The exact position stays in the anchor XML.
  return emuToIn(offset) + widthIn / 2 < contentWidthIn / 2 ? 'left' : 'right';
}

function emuSize(el: Element | undefined, wAttr: string, hAttr: string): { w: number; h: number } | null {
  if (!el) return null;
  const w = Number(el.getAttribute(wAttr));
  const h = Number(el.getAttribute(hAttr));
  if (!(w > 0) || !(h > 0)) return null;
  const wi = emuToIn(w);
  const hi = emuToIn(h);
  return wi <= MAX_SIZE_IN && hi <= MAX_SIZE_IN ? { w: round4(wi), h: round4(hi) } : null;
}

function cropOf(blipFill: Element | undefined): { l: number; t: number; r: number; b: number } | null {
  const src = blipFill && childElements(blipFill).find(c => c.namespaceURI === A_NS && c.localName === 'srcRect');
  if (!src) return null;
  const pct = (name: string): number => {
    const v = Number(src.getAttribute(name));
    return Number.isFinite(v) ? round4(v / 1000) : 0;
  };
  const crop = { l: pct('l'), t: pct('t'), r: pct('r'), b: pct('b') };
  return crop.l || crop.t || crop.r || crop.b ? crop : null;
}

function drawingRun(drawing: Element): Element | null {
  const parent = drawing.parentNode as Element | null;
  return parent && parent.nodeType === 1 && parent.localName === 'r' ? parent : null;
}

/** Keep the run (its properties and the drawing) the image came from, like any opaque atom. */
function preserveRun(drawing: Element, ctx: ReadContext): string {
  const run = drawingRun(drawing);
  let fragment;
  if (run) {
    const rPr = firstW(run, 'rPr');
    fragment = captureShell(run, rPr ? [rPr, drawing] : [drawing]);
  } else fragment = captureFragment(drawing);
  const id = ctx.nextId();
  ctx.preservation.fragments[id] = fragment;
  return id;
}

/**
 * One `w:drawing` -> an image node (never stamped with paragraph provenance: the caller decides whether it stands for a paragraph
 * or is lifted out of one), or null when it is not a picture the editor can hold. Null is not a loss: the caller keeps the drawing
 * as an opaque atom. A null for a PICTURE that could not be loaded also warns (once per reason).
 *
 * Categories: an inline picture and a picture floated left or right by `wrapSquare` / `wrapTight` are category 1
 * (`inlineImage`, `floatingImageSquare`); a picture behind or in front of text, with text above and below, centred, or with no
 * wrap is shown on a line of its own and is category 2 (`floatingImageOther`).
 */
export function readDrawing(drawing: Element, ctx: ReadContext): JSONContent | null {
  const media = ctx.media;
  if (!media) return null;
  const container = wp(drawing, 'inline') ?? wp(drawing, 'anchor');
  if (!container) return null;
  const graphic = childElements(container).find(c => c.namespaceURI === A_NS && c.localName === 'graphic');
  const data = graphic && childElements(graphic).find(c => c.namespaceURI === A_NS && c.localName === 'graphicData');
  if (!data || data.getAttribute('uri') !== PICTURE_URI) return null;
  const pic = childElements(data).find(c => c.namespaceURI === PIC_NS && c.localName === 'pic');
  const blipFill = pic && childElements(pic).find(c => c.namespaceURI === PIC_NS && c.localName === 'blipFill');
  const blip = blipFill && childElements(blipFill).find(c => c.namespaceURI === A_NS && c.localName === 'blip');
  if (!blip) return null;

  const embedId = blip.getAttributeNS(REL_NS, 'embed') || '';
  const linkId = blip.getAttributeNS(REL_NS, 'link') || '';
  const embedded = embedId ? media.byRel.get(embedId) : undefined;
  const linked = linkId ? media.byRel.get(linkId) : undefined;
  const why = (m: MediaLookup | undefined): MediaFailure | undefined => (m && 'reason' in m ? m.reason : undefined);
  const asset = embedded && 'data' in embedded ? embedded : null;
  const external = why(embedded) === 'external' || why(linked) === 'external';
  if (!asset && !external) {
    // Nothing to show and nothing linked: the drawing stays an opaque atom, and the author is told why.
    const reason = why(embedded) ?? why(linked) ?? 'missing-rel';
    warnOnce(ctx.report, 'part', FAILURE_MESSAGE[reason as Exclude<MediaFailure, 'external'>], 3);
    return null;
  }

  const contentWidthIn = ctx.contentWidthIn && ctx.contentWidthIn > 0 ? ctx.contentWidthIn : DEFAULT_CONTENT_WIDTH_IN;
  const size =
    emuSize(wp(container, 'extent'), 'cx', 'cy') ??
    emuSize(
      childElements(pic!).find(c => c.namespaceURI === PIC_NS && c.localName === 'spPr')
        ?.getElementsByTagNameNS(A_NS, 'ext')[0],
      'cx',
      'cy',
    );
  const isInline = container.localName === 'inline';
  const kind = isInline ? 'inline' : classifyWrap(container);
  let wrap: 'inline' | 'left' | 'right' | 'block' = 'block';
  let feature: 'inlineImage' | 'floatingImageSquare' | 'floatingImageOther' = 'floatingImageOther';
  if (isInline) {
    wrap = 'inline';
    feature = 'inlineImage';
  } else if (kind === 'square' || kind === 'tight') {
    const side = floatSide(container, size?.w ?? null, contentWidthIn);
    if (side) {
      wrap = side;
      feature = 'floatingImageSquare';
    }
  }

  const docPr = wp(container, 'docPr');
  const crop = cropOf(blipFill);
  const attrs: Record<string, unknown> = {
    src: null,
    assetId: asset ? asset.id : null,
    alt: docPr?.getAttribute('descr') ?? '',
    title: docPr?.getAttribute('title') ?? '',
    width: size ? `${Math.max(1, Math.min(100, Math.round((size.w / contentWidthIn) * 1000) / 10))}%` : '100%',
    align: wrap === 'right' ? 'right' : wrap === 'block' ? 'center' : 'left',
    wrap,
    widthIn: size?.w ?? null,
    heightIn: size?.h ?? null,
    crop,
  };

  if (asset) {
    registerAsset(ctx, asset);
    if (asset.mime === 'image/svg+xml') warnOnce(ctx.report, 'part', SVG_NOTE, 2);
  } else {
    warnOnce(ctx.report, 'part', LINKED_IMAGE, 2);
  }
  if (!size) warnOnce(ctx.report, 'part', NO_SIZE, 2);
  if (crop) warnOnce(ctx.report, 'part', CROPPED, 2);
  recordFeature(ctx.report, feature);
  if (feature === 'floatingImageOther') warnOnce(ctx.report, 'floatingImageOther', FLOATING_OTHER, 2);
  attrs.fragmentId = preserveRun(drawing, ctx);
  return { type: 'resizableImage', attrs };
}

// ─── captions ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FigureMatch {
  /** Index of the image among the blocks given. */
  image: number;
  /** Index of its caption among the same blocks, or null when no caption was found. */
  caption: number | null;
  /** `style`: the paragraph is in Word's Caption style. `label`: it opens with "Fig. N." / "Figure N:" (most grants never use the style). */
  how: 'style' | 'label' | null;
}

/** A caption looks past this many blocks after its image no further: the image's paragraph, then the text that flows beside it. */
const CAPTION_WINDOW = 3;
const LABEL = /^\s*(?:supplementary\s+|extended\s+data\s+)?fig(?:ure)?s?\.?\s*S?\d+[A-Za-z]?\s*[.:|–—-]/i;
const LABEL_BEFORE_FIELD = /^\s*(?:supplementary\s+|extended\s+data\s+)?fig(?:ure)?\.?\s*$/i;

/** Zero-width markers (a comment range, a bookmark) may open a caption without being part of what it says. */
const isMarker = (n: JSONContent): boolean => n.type === 'opaqueInline' && (n.attrs?.label === 'comment anchor' || n.attrs?.label === 'bookmark');

function leadingText(p: JSONContent): { text: string; followedByAtom: boolean } {
  let text = '';
  for (const c of p.content ?? []) {
    if (c.type === 'text') text += c.text ?? '';
    else if (!isMarker(c)) return { text, followedByAtom: c.type === 'opaqueInline' };
  }
  return { text, followedByAtom: false };
}

function captionKind(block: JSONContent): 'style' | 'label' | null {
  if (block.type !== 'paragraph') return null;
  if (block.attrs?.styleId === 'caption') return 'style';
  const { text, followedByAtom } = leadingText(block);
  // "Figure " + a SEQ field + ". Text" arrives as text, then a field atom: the number is not in the text.
  return LABEL.test(text) || (followedByAtom && LABEL_BEFORE_FIELD.test(text)) ? 'label' : null;
}

/**
 * Pair each image among the blocks of ONE container (the body, or one table cell) with its caption: the nearest following
 * paragraph in Word's Caption style, else one that opens like a caption ("Fig. 3." / "Figure 3:"; plain "Figure 3 shows" does
 * not count), within a few blocks and not past the next figure, each caption used once. Pure and derived: nothing is stored on
 * the nodes, so an edit can never leave a stale link. A picture lifted out of a paragraph of text comes immediately before that
 * paragraph, so the caption written after the picture's paragraph is within reach.
 */
export function matchCaptions(blocks: JSONContent[]): FigureMatch[] {
  const taken = new Set<number>();
  const out: FigureMatch[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== 'resizableImage') return;
    let found: FigureMatch = { image: i, caption: null, how: null };
    let seen = 0;
    for (let k = i + 1; k < blocks.length && seen < CAPTION_WINDOW; k++) {
      const next = blocks[k];
      if (next.type === 'resizableImage') {
        if (next.attrs?.anchorBlockId) continue; // another picture lifted out of the same paragraph
        break; // the next figure
      }
      seen += 1;
      const how = taken.has(k) ? null : captionKind(next);
      if (how) {
        taken.add(k);
        found = { image: i, caption: k, how };
        break;
      }
    }
    out.push(found);
  });
  return out;
}

/**
 * Writer-side detection for pictures the DOCX reader lifted out of a paragraph (docx/read/drawings.ts).
 *
 * A picture anchored in a paragraph of text is an image node placed immediately before that paragraph (`anchorBlockId` = the
 * paragraph's `ooxml.blockId`). The paragraph's original XML (`preservation.blocks[blockId].xml`) still contains the `w:drawing`,
 * and the paragraph is re-emitted verbatim while it is untouched. So, once the author has deleted, moved or copied a lifted
 * picture, the image nodes alone cannot say what to do about the drawing still sitting in that XML. What can: the read-time
 * record on the block entry, `lifted: [{ fragmentId, drawingIndex }]` (`drawingIndex` = the ordinal of the picture among ALL
 * `w:drawing` elements of that `<w:p>`, in document order; `docPr@id` is NOT used, those ids are not unique). Block entries are
 * never pruned, so the record outlives the node.
 *
 * `planLiftedDrawings` compares the record with the document and says what a writer must do:
 *   - `strip`: remove the `drawingIndex`-th `w:drawing` from the host paragraph's original XML before re-emitting it verbatim
 *     (its picture was deleted, or moved elsewhere). When the host is REBUILT instead, strips are implicit: nothing is carried over.
 *   - STRIPS ARE ORDERED DESCENDING by `drawingIndex` within a host (hosts in `hostBlockId` order). Apply them in the order given, or
 *     snapshot the host's `w:drawing` list before removing anything: removing `drawings[1]` first shifts every later ordinal down by
 *     one, and an ascending sweep strips the wrong pictures.
 *   - `emit`: write this image from its fragment (`preservation.fragments[fragmentId]`, the `<w:r>` with the whole drawing) at its
 *     place in the model, because it is a copy (its `fragmentId` is in no record: the paste guard gave the copy a fresh one), or
 *     was moved away from its host, or its host paragraph was deleted. `why: 'host-edited'` marks a picture still in place but
 *     whose host was edited and so is rebuilt: put the run back INTO that host.
 *
 * AN EDIT TO A PICTURE THAT STAYS IN PLACE. The host is untouched, so on its own it would be re-emitted verbatim, silently losing the
 * edit. The read therefore also records each picture's `sourceHash` (the `blockHash` of the node as read; `src`, a session blob:
 * URL, is not part of it), and a node in place whose hash has changed is reported as `emit` with `why: 'edited'`: re-emit the host
 * verbatim with THIS drawing patched from the node (or, if the host is also rebuilt, it is `host-edited` and is written from the
 * node anyway). Patch from these attrs: the size from `width` (the share of the text area the editor changes when the user
 * resizes; `widthIn` / `heightIn` are the size AS READ and go stale; keep the aspect ratio of `widthIn`:`heightIn`) into `wp:extent`
 * and the picture's `a:ext`; `alt` and `title` into `wp:docPr@descr` / `@title`; `crop` into `a:srcRect` (percent x 1000);
 * `wrap` and `align` into the `wp:wrap*` and `wp:positionH` of the anchor (a change of side is `wp:positionH`; a change to
 * `inline` or `block` cannot be expressed in the anchor, so rebuild the drawing as inline or topAndBottom); and `assetId`.
 *
 * `assetId` IS THE ONE ATTRIBUTE THAT CHANGES THE BYTES. Every other attribute above is a property of the same picture; a different
 * `assetId` means the author REPLACED the picture (the content-addressed id is a hash of the bytes), and `blockHash` counts it, so
 * the node reads as `edited`. Patching a size into the old `w:drawing` would keep showing the old picture. The writer must: take the
 * new bytes and mime from the asset store by `assetId`; add them as a NEW media part (never overwrite the old one: the old part may
 * still be used by a copy, and an orphaned part is harmless) with its content-type `Default`/`Override` if the extension is new;
 * add a NEW relationship to `word/_rels/document.xml.rels` with an id that collides with neither the original rels file nor
 * `preservation.rels`; and point the drawing's `a:blip@r:embed` at it (and drop `r:link` if the old blip had one). Size, crop and alt
 * are then patched as above; the new picture's pixel dimensions are not those of the old, so honour `width` and the aspect ratio of
 * the NEW bytes, not of `widthIn`:`heightIn`. A record without a `sourceHash` (an older import) cannot detect any of this.
 *
 * AN IMAGE THE AUTHOR INSERTED IS NOT IN THE PLAN, AND THAT IS A GAP THE WRITER MUST FILL. It has no `fragmentId` (it was never read
 * from a file) and no record, so the loop below skips it (`continue`): `planLiftedDrawings` reports neither an `emit` nor a `strip`
 * for it, and nothing else in the preservation layer mentions it. A writer that emits only what the plan lists drops it silently.
 * Find these by walking the model: a `resizableImage` with an empty `fragmentId` and no `ooxml` (and, for a picture whose
 * `fragmentId` is set but unrecorded, the plan already says `copy`). For each, the writer creates from nothing: a new media part
 * from the asset (`assetId`) with its content type, a new relationship, and a new `w:drawing` at the node's place in the model
 * (`wp:inline` for `wrap` null or `inline`; a `wp:anchor` with `wrapSquare` for `left` / `right`; a line of its own for `block`;
 * extent from `width` times the text-area width, aspect ratio from the bytes; `alt` / `title` into `wp:docPr@descr` / `@title`
 * with a `docPr@id` unused anywhere in the document), inside a `w:r` inside its own `w:p` (an image is a block in the model).
 * It has no host paragraph, no bookmark and no caption pairing beyond what `matchCaptions` finds.
 *
 * WHAT THE CONTRACT STILL OMITS. Where in a REBUILT host a surviving run goes is not recorded: the picture's original position in
 * the paragraph's runs is gone with the verbatim XML. The rule is to put the run at the START of the host's content, in image
 * order. For a floating (anchored) picture that is faithful (its position is relative to the paragraph, not to a character). For
 * an INLINE picture lifted from the middle of a sentence it is not: the original text offset is lost, and the picture moves to the
 * front of its paragraph. A picture that stood for a whole paragraph (`ooxml` on the image) is a different case: it is never
 * lifted, so none of this applies to it.
 */
import type { JSONContent } from '@tiptap/core';
import { blockHash, isBlockUntouched } from './hash';
import type { PreservationStore } from './types';

export interface LiftedStrip {
  hostBlockId: string;
  drawingIndex: number;
  fragmentId: string;
  why: 'deleted' | 'moved';
}

export interface LiftedEmit {
  node: JSONContent;
  fragmentId: string;
  why: 'copy' | 'moved' | 'host-edited' | 'edited';
  /** The paragraph the picture was lifted from, when the record knows it (null for a copy of an unrecorded picture). */
  hostBlockId: string | null;
}

export interface LiftedPlan {
  strip: LiftedStrip[];
  emit: LiftedEmit[];
}

const blockIdOf = (n: JSONContent): string | undefined => (n.attrs?.ooxml as { blockId?: string } | null | undefined)?.blockId;

const holds = (n: JSONContent, blockId: string): boolean => blockIdOf(n) === blockId || (n.content ?? []).some(c => holds(c, blockId));

export function planLiftedDrawings(doc: JSONContent, store: Pick<PreservationStore, 'blocks'>): LiftedPlan {
  // what the read recorded: fragmentId -> its host and ordinal
  const recorded = new Map<string, { hostBlockId: string; drawingIndex: number; sourceHash?: string }>();
  for (const [hostBlockId, entry] of Object.entries(store.blocks)) {
    for (const l of entry.lifted ?? []) recorded.set(l.fragmentId, { hostBlockId, drawingIndex: l.drawingIndex, sourceHash: l.sourceHash });
  }
  if (!recorded.size) return { strip: [], emit: [] }; // nothing was lifted at read time

  const hosts = new Map<string, JSONContent>();
  const images: Array<{ node: JSONContent; siblings: JSONContent[]; at: number }> = [];
  const walk = (n: JSONContent, siblings: JSONContent[], at: number): void => {
    const id = blockIdOf(n);
    if (id && n.type !== 'resizableImage') hosts.set(id, n);
    if (n.type === 'resizableImage') images.push({ node: n, siblings, at });
    (n.content ?? []).forEach((c, i, all) => walk(c, all, i));
  };
  walk(doc, [], 0);

  /** Still where it was read: only other lifted pictures between it and the entry that holds its host. */
  const inPlace = (img: { siblings: JSONContent[]; at: number }, hostBlockId: string): boolean => {
    let j = img.at + 1;
    while (img.siblings[j]?.type === 'resizableImage' && img.siblings[j].attrs?.anchorBlockId) j++;
    const entry = img.siblings[j];
    return !!entry && holds(entry, hostBlockId);
  };

  const plan: LiftedPlan = { strip: [], emit: [] };
  const seen = new Set<string>();
  for (const img of images) {
    const fragmentId = img.node.attrs?.fragmentId as string | undefined;
    if (!fragmentId || blockIdOf(img.node)) continue; // inserted by the author (no fragment), or a picture that stands for a whole paragraph
    const rec = recorded.get(fragmentId);
    if (!rec || seen.has(fragmentId)) {
      plan.emit.push({ node: img.node, fragmentId, why: 'copy', hostBlockId: rec?.hostBlockId ?? null });
      continue;
    }
    seen.add(fragmentId);
    const host = hosts.get(rec.hostBlockId);
    if (img.node.attrs?.anchorBlockId === rec.hostBlockId && host && inPlace(img, rec.hostBlockId)) {
      if (!isBlockUntouched(host)) plan.emit.push({ node: img.node, fragmentId, why: 'host-edited', hostBlockId: rec.hostBlockId });
      else if (rec.sourceHash !== undefined && blockHash(img.node) !== rec.sourceHash) {
        plan.emit.push({ node: img.node, fragmentId, why: 'edited', hostBlockId: rec.hostBlockId });
      }
    } else {
      plan.emit.push({ node: img.node, fragmentId, why: 'moved', hostBlockId: rec.hostBlockId });
      if (host) plan.strip.push({ hostBlockId: rec.hostBlockId, drawingIndex: rec.drawingIndex, fragmentId, why: 'moved' });
    }
  }
  for (const [fragmentId, rec] of recorded) {
    if (!seen.has(fragmentId) && hosts.has(rec.hostBlockId)) plan.strip.push({ hostBlockId: rec.hostBlockId, drawingIndex: rec.drawingIndex, fragmentId, why: 'deleted' });
  }
  const order = (a: LiftedStrip, b: LiftedStrip) => a.hostBlockId.localeCompare(b.hostBlockId) || b.drawingIndex - a.drawingIndex;
  plan.strip.sort(order);
  return plan;
}

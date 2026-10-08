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
 *   - `emit`: write this image from its fragment (`preservation.fragments[fragmentId]`, the `<w:r>` with the whole drawing) at its
 *     place in the model, because it is a copy (its `fragmentId` is in no record: the paste guard gave the copy a fresh one), or
 *     was moved away from its host, or its host paragraph was deleted. `why: 'host-edited'` marks a picture still in place but
 *     whose host was edited and so is rebuilt: put the run back INTO that host.
 *
 * WHAT THE CONTRACT STILL OMITS. Where in a REBUILT host a surviving run goes is not recorded: the picture's original position in
 * the paragraph's runs is gone with the verbatim XML. The rule is to put the run at the START of the host's content, in image
 * order. For a floating (anchored) picture that is faithful (its position is relative to the paragraph, not to a character). For
 * an INLINE picture lifted from the middle of a sentence it is not: the original text offset is lost, and the picture moves to the
 * front of its paragraph. A picture that stood for a whole paragraph (`ooxml` on the image) is a different case: it is never
 * lifted, so none of this applies to it.
 */
import type { JSONContent } from '@tiptap/core';
import { isBlockUntouched } from './hash';
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
  why: 'copy' | 'moved' | 'host-edited';
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
  const recorded = new Map<string, { hostBlockId: string; drawingIndex: number }>();
  for (const [hostBlockId, entry] of Object.entries(store.blocks)) {
    for (const l of entry.lifted ?? []) recorded.set(l.fragmentId, { hostBlockId, drawingIndex: l.drawingIndex });
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
    } else {
      plan.emit.push({ node: img.node, fragmentId, why: 'moved', hostBlockId: rec.hostBlockId });
      if (host) plan.strip.push({ ...rec, fragmentId, why: 'moved' });
    }
  }
  for (const [fragmentId, rec] of recorded) {
    if (!seen.has(fragmentId) && hosts.has(rec.hostBlockId)) plan.strip.push({ ...rec, fragmentId, why: 'deleted' });
  }
  const order = (a: LiftedStrip, b: LiftedStrip) => a.hostBlockId.localeCompare(b.hostBlockId) || a.drawingIndex - b.drawingIndex;
  plan.strip.sort(order);
  return plan;
}

import type { JSONContent } from '@tiptap/core';
import type { PreservationStore } from './types';

export function collectFragmentIds(doc: JSONContent): Set<string> {
  const ids = new Set<string>();
  const walk = (n: JSONContent) => {
    // an image keeps the run it was read from (empty for an image the author inserted)
    if ((n.type === 'opaqueInline' || n.type === 'opaqueBlock' || n.type === 'resizableImage') && typeof n.attrs?.fragmentId === 'string' && n.attrs.fragmentId) {
      ids.add(n.attrs.fragmentId);
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return ids;
}

/**
 * Drop every fragment no node references. THE WRITER MUST TOLERATE A MISSING FRAGMENT. Pruning keeps a fragment while the current
 * row or any backup (the 10-entry ring, plus pinned ones) references it, but undo past the ring can restore an atom whose fragment
 * was already pruned: the node then has a `fragmentId` that is in no `preservation.fragments`. Export must not throw on it: skip the
 * atom with a warning (its chip is the only trace left), and for a picture fall back to emitting it from the model (as for an
 * image the author inserted). See docs/superpowers/specs/2026-10-07-a2b-writer-contract.md section 4.
 */
export function pruneFragments(store: PreservationStore, referenced: Set<string>): PreservationStore {
  const fragments: PreservationStore['fragments'] = {};
  for (const [id, f] of Object.entries(store.fragments)) if (referenced.has(id)) fragments[id] = f;
  return { ...store, fragments };
}
